/**
 * 去中心化消息 mesh：节点互连 + 群消息 gossip / 私聊单播
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import {
  HTTP_PORT,
  WS_PORT,
  loadState,
  ensureClientId,
  appendMessage,
  getMessages,
  getGroup,
  upsertGroup,
  isDmGroup,
  addMemberToGroup,
} from './store.mjs';
import { handleFileOffer, chatWire } from './file-transfer.mjs';

function acceptKey(secKey) {
  return crypto
    .createHash('sha1')
    .update(String(secKey) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function encodeTextFrame(text, masked = false) {
  const payload = Buffer.from(String(text), 'utf8');
  const len = payload.length;
  let header;
  if (masked) {
    const mask = crypto.randomBytes(4);
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const maskedPayload = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) maskedPayload[i] = payload[i] ^ mask[i % 4];
    return Buffer.concat([header, mask, maskedPayload]);
  }
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let headerLen = 2;
    if (len === 126) {
      if (offset + 4 > buffer.length) break;
      len = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (len === 127) {
      if (offset + 10 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }
    const maskLen = masked ? 4 : 0;
    const total = headerLen + maskLen + len;
    if (offset + total > buffer.length) break;
    let payload = buffer.subarray(offset + headerLen + maskLen, offset + total);
    if (masked) {
      const mask = buffer.subarray(offset + headerLen, offset + headerLen + 4);
      const out = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i % 4];
      payload = out;
    }
    frames.push({ opcode, payload });
    offset += total;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/** @type {Map<string, { socket: net.Socket, meta: object, outbound: boolean }>} */
const peers = new Map();
/** @type {http.Server | null} */
let server = null;
/** @type {(() => void) | null} */
let onChange = null;
/** @type {Set<string>} */
const seenMsgIds = new Set();
/** @type {ReturnType<typeof setInterval> | null} */
let reconnectTimer = null;

function peerKey(clientId, host) {
  return clientId || host || '';
}

function findPeerByClientId(clientId) {
  const id = String(clientId || '');
  if (!id) return null;
  for (const row of peers.values()) {
    if (row.meta?.clientId === id && row.socket && !row.socket.destroyed) return row;
  }
  return null;
}

function sendSocket(socket, obj, outbound) {
  if (!socket || socket.destroyed) return;
  try {
    socket.write(encodeTextFrame(JSON.stringify(obj), outbound));
  } catch {
    /* ignore */
  }
}

function broadcast(obj, exceptSocket = null) {
  for (const row of peers.values()) {
    if (row.socket === exceptSocket) continue;
    sendSocket(row.socket, obj, row.outbound);
  }
}

/** 单播给指定 clientId；找不到则退化为广播（除私聊强制要求找到） */
export function sendToPeer(clientId, obj, { require = false } = {}) {
  const row = findPeerByClientId(clientId);
  if (row) {
    sendSocket(row.socket, obj, row.outbound);
    return true;
  }
  if (require) return false;
  broadcast(obj);
  return false;
}

function routeOutgoing(obj, peerClientId) {
  if (peerClientId) {
    sendToPeer(peerClientId, obj, { require: true });
    // 若尚未连上，仍尝试广播一次以免丢失？私聊不广播
    if (!findPeerByClientId(peerClientId)) {
      // 仅当能按 host 连接时由上层保证；此处不广播私聊内容
    }
    return;
  }
  broadcast(obj);
}

function rememberMsg(msgId) {
  seenMsgIds.add(msgId);
  if (seenMsgIds.size > 5000) {
    const arr = [...seenMsgIds];
    for (let i = 0; i < 1000; i++) seenMsgIds.delete(arr[i]);
  }
}

function peerMetaForSocket(socket) {
  for (const row of peers.values()) {
    if (row.socket === socket) return row.meta || {};
  }
  return {};
}

function socketRemoteHost(socket) {
  return String(socket?.remoteAddress || '')
    .replace(/^::ffff:/, '')
    .replace(/^::1$/, '127.0.0.1');
}

function handleMessage(msg, socket, outbound, expectedHost = '') {
  if (!msg || typeof msg !== 'object') return;
  const state = loadState();

  if (msg.type === 'hello') {
    const clientId = String(msg.clientId || '').trim();
    if (!clientId || clientId === state.clientId) return;
    const claimed = String(msg.host || '')
      .replace(/^::ffff:/, '')
      .replace(/^::1$/, '127.0.0.1');
    // 出站：对端就是我们 dial 的 host；入站：优先 socket 远端，其次对方自报
    const host = outbound
      ? expectedHost || claimed || socketRemoteHost(socket)
      : socketRemoteHost(socket) || claimed;
    const key = peerKey(clientId, host);
    const prev = peers.get(key);
    if (prev && prev.socket !== socket && !prev.socket.destroyed) {
      try {
        prev.socket.destroy();
      } catch {
        /* ignore */
      }
    }
    const meta = {
      clientId,
      name: String(msg.name || ''),
      host,
      wsPort: Number(msg.wsPort) || WS_PORT,
      httpPort: Number(msg.httpPort) || HTTP_PORT,
    };
    peers.set(key, { socket, outbound, meta });
    // 回写成员 host，便于断线重连与文件拉取
    if (host) {
      for (const g of state.groups || []) {
        const memberIds = new Set((g.members || []).map((m) => m.clientId));
        if (!memberIds.has(clientId)) continue;
        addMemberToGroup(g.id, {
          clientId,
          name: meta.name,
          host,
          httpPort: meta.httpPort,
          wsPort: meta.wsPort,
        });
      }
    }
    for (const g of loadState().groups || []) {
      const memberIds = new Set((g.members || []).map((m) => m.clientId));
      if (!memberIds.has(clientId)) continue;
      const recent = getMessages(g.id, 100);
      if (recent.length) {
        // sync 不带本机 media 二进制，仅元数据；对方若缺文件可再拉
        const sanitized = recent.map((m) => ({
          ...m,
          mediaId: m.fromId === state.clientId ? '' : m.mediaId,
          status: m.kind === 'text' ? 'complete' : m.mediaId ? 'complete' : m.status,
        }));
        sendSocket(socket, { type: 'sync', groupId: g.id, messages: sanitized }, outbound);
      }
      sendSocket(socket, { type: 'group-meta', group: g }, outbound);
    }
    onChange?.();
    return;
  }

  if (msg.type === 'group-meta' && msg.group?.id) {
    const g = msg.group;
    const mine = getGroup(g.id);
    const state2 = loadState();
    const memberIds = new Set((g.members || []).map((m) => m.clientId));
    if (mine || memberIds.has(state2.clientId)) {
      upsertGroup(g);
      onChange?.();
    }
    return;
  }

  if (msg.type === 'sync' && msg.groupId && Array.isArray(msg.messages)) {
    let any = false;
    for (const m of msg.messages) {
      if (!m?.msgId) continue;
      if (seenMsgIds.has(m.msgId)) continue;
      const { added } = appendMessage(m);
      if (added) {
        rememberMsg(m.msgId);
        any = true;
      }
    }
    if (any) onChange?.();
    return;
  }

  if (msg.type === 'file-offer') {
    const meta = peerMetaForSocket(socket);
    void handleFileOffer(msg, meta);
    return;
  }

  if (msg.type === 'file-ack') {
    // 目前仅作确认日志；出站 transfer 仍按超时清理
    return;
  }

  if (msg.type === 'chat' && msg.msgId && msg.groupId) {
    if (seenMsgIds.has(msg.msgId)) return;
    const group = getGroup(msg.groupId);
    if (!group) return;
    // 私聊：仅当本机是成员且来源是对方时接收
    if (isDmGroup(group)) {
      const ids = new Set((group.members || []).map((m) => m.clientId));
      if (!ids.has(state.clientId) || !ids.has(msg.fromId)) return;
    }
    rememberMsg(msg.msgId);
    const wire = {
      msgId: msg.msgId,
      groupId: msg.groupId,
      fromId: msg.fromId,
      fromName: msg.fromName,
      text: msg.text,
      ts: msg.ts,
      kind: msg.kind || 'text',
      fileName: msg.fileName || '',
      mime: msg.mime || '',
      size: msg.size || 0,
      transferId: msg.transferId || '',
      mediaId: '',
      status: msg.kind && msg.kind !== 'text' ? 'pending' : 'complete',
    };
    const { added } = appendMessage(wire);
    if (added) {
      if (isDmGroup(group)) {
        // 私聊不 gossip
      } else {
        broadcast(chatWire({ ...wire, httpPort: msg.httpPort }), socket);
      }
      onChange?.();
      // 若 chat 自带 transfer 信息且无后续 file-offer，尝试拉取
      if (wire.transferId && wire.kind !== 'text') {
        const meta = peerMetaForSocket(socket);
        void handleFileOffer(
          {
            ...wire,
            type: 'file-offer',
            httpPort: msg.httpPort || meta.httpPort,
            hostHint: meta.host,
          },
          meta
        );
      }
    }
  }
}

function attachSocket(socket, { outbound = false, expectedHost = '' } = {}) {
  let buf = Buffer.alloc(0);
  let handshakeDone = !outbound;

  const finishHello = () => {
    const state = ensureClientId();
    sendSocket(
      socket,
      {
        type: 'hello',
        clientId: state.clientId,
        name: state.name,
        host: expectedHost || '',
        wsPort: WS_PORT,
        httpPort: HTTP_PORT,
        ts: Date.now(),
      },
      outbound
    );
  };

  if (!outbound) {
    finishHello();
  }

  socket.on('data', (chunk) => {
    if (outbound && !handshakeDone) {
      buf = Buffer.concat([buf, chunk]);
      const text = buf.toString('utf8');
      const idx = text.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const header = text.slice(0, idx);
      if (!/^HTTP\/1\.1 101/i.test(header)) {
        socket.destroy();
        return;
      }
      handshakeDone = true;
      const rest = buf.subarray(idx + 4);
      buf = Buffer.alloc(0);
      finishHello();
      if (rest.length) socket.emit('data', rest);
      return;
    }

    buf = Buffer.concat([buf, chunk]);
    const { frames, rest } = decodeFrames(buf);
    buf = rest;
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }
      if (frame.opcode !== 0x1) continue;
      let msg;
      try {
        msg = JSON.parse(frame.payload.toString('utf8'));
      } catch {
        continue;
      }
      handleMessage(msg, socket, outbound, expectedHost);
    }
  });

  const cleanup = () => {
    for (const [k, row] of peers) {
      if (row.socket === socket) peers.delete(k);
    }
    onChange?.();
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

export function startMesh(opts = {}) {
  onChange = opts.onChange || onChange;
  if (server) return server;

  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('lan-mesh-chat');
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/mesh') {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '',
      '',
    ].join('\r\n');
    socket.write(headers);
    if (head?.length) socket.unshift(head);
    attachSocket(socket, { outbound: false });
  });

  server.listen(WS_PORT, '0.0.0.0', () => {
    console.log(`[lan-mesh] WS ws://0.0.0.0:${WS_PORT}/mesh`);
  });
  server.on('error', (err) => console.error('[lan-mesh] WS failed', err));

  if (reconnectTimer) clearInterval(reconnectTimer);
  reconnectTimer = setInterval(() => {
    void connectKnownMembers();
  }, 8000);

  return server;
}

export function connectToPeer(host, wsPort = WS_PORT) {
  const h = String(host || '').trim();
  if (!h) return;
  for (const row of peers.values()) {
    if (row.meta?.host === h && row.socket && !row.socket.destroyed) return;
  }

  const port = Number(wsPort) || WS_PORT;
  const key = crypto.randomBytes(16).toString('base64');
  const socket = net.connect({ host: h, port }, () => {
    socket.write(
      [
        `GET /mesh HTTP/1.1`,
        `Host: ${h}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n')
    );
  });
  attachSocket(socket, { outbound: true, expectedHost: h });
  socket.on('error', () => {
    /* ignore */
  });
}

export async function connectKnownMembers() {
  const state = loadState();
  const hosts = new Map();
  for (const g of state.groups || []) {
    for (const m of g.members || []) {
      if (m.clientId === state.clientId) continue;
      if (m.host) hosts.set(m.host, m.wsPort || WS_PORT);
    }
  }
  for (const [host, wsPort] of hosts) {
    connectToPeer(host, wsPort);
  }
}

export function publishChat({ groupId, text }) {
  const state = ensureClientId();
  if (!state.name) throw new Error('请先设置花名');
  const group = getGroup(groupId);
  if (!group) throw new Error('会话不存在');
  const msg = {
    type: 'chat',
    msgId: crypto.randomBytes(10).toString('hex'),
    groupId,
    fromId: state.clientId,
    fromName: state.name,
    text: String(text || '').trim(),
    ts: Date.now(),
    kind: 'text',
    status: 'complete',
  };
  if (!msg.text) throw new Error('消息不能为空');
  rememberMsg(msg.msgId);
  appendMessage(msg);

  if (isDmGroup(group)) {
    const other = (group.members || []).find((m) => m.clientId !== state.clientId);
    if (other?.clientId) {
      sendToPeer(other.clientId, msg, { require: false });
      // 若还没 hello 映射，按 host 直连后再发一次
      if (other.host) connectToPeer(other.host, other.wsPort || WS_PORT);
      if (!findPeerByClientId(other.clientId) && other.host) {
        // 短暂延迟后重试单播
        setTimeout(() => sendToPeer(other.clientId, msg, { require: true }), 500);
      }
    }
  } else {
    broadcast(msg);
    for (const m of group.members || []) {
      if (m.clientId === state.clientId) continue;
      if (m.host) connectToPeer(m.host, m.wsPort || WS_PORT);
    }
  }
  onChange?.();
  return msg;
}

export function announceGroup(group) {
  if (!group?.id) return;
  if (isDmGroup(group)) {
    const state = ensureClientId();
    const other = (group.members || []).find((m) => m.clientId !== state.clientId);
    if (other?.clientId) {
      sendToPeer(other.clientId, { type: 'group-meta', group }, { require: false });
      if (other.host) connectToPeer(other.host, other.wsPort || WS_PORT);
      setTimeout(() => {
        sendToPeer(other.clientId, { type: 'group-meta', group }, { require: true });
      }, 400);
    }
    return;
  }
  broadcast({ type: 'group-meta', group });
}

export function getMeshStatus() {
  const list = [];
  for (const row of peers.values()) {
    if (row.socket?.destroyed) continue;
    list.push({ ...row.meta, connected: true });
  }
  return { peers: list, count: list.length };
}

export function meshSendSignal(obj, peerClientId) {
  routeOutgoing(obj, peerClientId);
}

export function stopMesh() {
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
  for (const row of peers.values()) {
    try {
      row.socket.destroy();
    } catch {
      /* ignore */
    }
  }
  peers.clear();
  if (server) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    server = null;
  }
}
