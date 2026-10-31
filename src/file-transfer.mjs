/**
 * 点对点文件 / 图片直传：WS 信令 + HTTP 拉流
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  HTTP_PORT,
  mediaDir,
  resolveMediaPath,
  ensureClientId,
  appendMessage,
  updateMessage,
  getGroup,
  isDmGroup,
} from './store.mjs';

const MAX_FILE_BYTES = 80 * 1024 * 1024; // 80MB

/** @type {Map<string, { filePath: string, fileName: string, mime: string, size: number, fromId: string, expiresAt: number }>} */
const outbound = new Map();
/** @type {Set<string>} */
const downloading = new Set();

/** @type {(() => void) | null} */
let onChange = null;
/** @type {((obj: object, peerClientId?: string) => void) | null} */
let sendSignal = null;
/** @type {((host: string, wsPort?: number) => void) | null} */
let connectPeer = null;

export function initFileTransfer(opts = {}) {
  onChange = opts.onChange || onChange;
  sendSignal = opts.sendSignal || sendSignal;
  connectPeer = opts.connectPeer || connectPeer;
}

function guessMime(fileName, fallback = 'application/octet-stream') {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.zip': 'application/zip',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
  };
  return map[ext] || fallback;
}

export function isImageMime(mime, fileName = '') {
  if (String(mime || '').startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(String(fileName || ''));
}

function copyIntoMedia(srcPath, preferredName) {
  const ext = path.extname(preferredName || srcPath) || '';
  const mediaId = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  const dest = path.join(mediaDir(), mediaId);
  fs.copyFileSync(srcPath, dest);
  return mediaId;
}

/**
 * 发送本地文件到会话（群或私聊）
 */
export function publishFile({ groupId, filePath, fileName }) {
  const state = ensureClientId();
  if (!state.name) throw new Error('请先设置花名');
  const group = getGroup(groupId);
  if (!group) throw new Error('会话不存在');

  const src = String(filePath || '');
  if (!src || !fs.existsSync(src)) throw new Error('文件不存在');
  const st = fs.statSync(src);
  if (!st.isFile()) throw new Error('不是文件');
  if (st.size <= 0) throw new Error('空文件');
  if (st.size > MAX_FILE_BYTES) throw new Error('文件过大（上限 80MB）');

  const name = String(fileName || path.basename(src));
  const mime = guessMime(name);
  const kind = isImageMime(mime, name) ? 'image' : 'file';
  const transferId = crypto.randomBytes(12).toString('hex');
  const mediaId = copyIntoMedia(src, name);

  outbound.set(transferId, {
    filePath: resolveMediaPath(mediaId),
    fileName: name,
    mime,
    size: st.size,
    fromId: state.clientId,
    expiresAt: Date.now() + 30 * 60 * 1000,
  });

  const msg = {
    type: 'chat',
    msgId: crypto.randomBytes(10).toString('hex'),
    groupId,
    fromId: state.clientId,
    fromName: state.name,
    text: kind === 'image' ? `[图片] ${name}` : `[文件] ${name}`,
    ts: Date.now(),
    kind,
    fileName: name,
    mime,
    size: st.size,
    transferId,
    mediaId,
    status: 'complete',
    httpPort: HTTP_PORT,
  };

  appendMessage(msg);
  const targetId = isDmGroup(group) ? otherMemberId(group, state.clientId) : undefined;
  const offer = {
    type: 'file-offer',
    transferId,
    msgId: msg.msgId,
    groupId,
    fromId: state.clientId,
    fromName: state.name,
    fileName: name,
    mime,
    size: st.size,
    kind,
    httpPort: HTTP_PORT,
    hostHint: '',
    ts: msg.ts,
  };
  for (const m of group.members || []) {
    if (m.clientId === state.clientId) continue;
    if (m.host) connectPeer?.(m.host, m.wsPort || undefined);
  }
  sendSignal?.(chatWire(msg), targetId);
  sendSignal?.(offer, targetId);
  if (targetId) {
    setTimeout(() => {
      sendSignal?.(chatWire(msg), targetId);
      sendSignal?.(offer, targetId);
    }, 500);
  }
  onChange?.();
  return msg;
}

function otherMemberId(group, selfId) {
  const other = (group.members || []).find((m) => m.clientId !== selfId);
  return other?.clientId || '';
}

function chatWire(msg) {
  return {
    type: 'chat',
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
    // 不把本机 mediaId 广播出去；对方需自行下载
    mediaId: '',
    status: msg.kind === 'text' ? 'complete' : 'pending',
    httpPort: msg.httpPort || HTTP_PORT,
  };
}

export function getOutboundTransfer(transferId) {
  const row = outbound.get(String(transferId || ''));
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    outbound.delete(transferId);
    return null;
  }
  return row;
}

export function pruneTransfers() {
  const now = Date.now();
  for (const [id, row] of outbound) {
    if (now > row.expiresAt) outbound.delete(id);
  }
}

/**
 * 处理收到的 file-offer：写入消息元数据并拉取文件
 */
export async function handleFileOffer(offer, peerMeta = {}) {
  if (!offer?.transferId || !offer?.msgId || !offer?.groupId) return;
  const state = ensureClientId();
  if (offer.fromId === state.clientId) return;

  const group = getGroup(offer.groupId);
  if (!group) return;

  const transferKey = String(offer.transferId);
  if (downloading.has(transferKey)) return;

  const kind = offer.kind === 'image' || isImageMime(offer.mime, offer.fileName) ? 'image' : 'file';
  const msg = {
    msgId: offer.msgId,
    groupId: offer.groupId,
    fromId: offer.fromId,
    fromName: offer.fromName || '',
    text: kind === 'image' ? `[图片] ${offer.fileName || ''}` : `[文件] ${offer.fileName || ''}`,
    ts: Number(offer.ts) || Date.now(),
    kind,
    fileName: String(offer.fileName || ''),
    mime: String(offer.mime || ''),
    size: Number(offer.size) || 0,
    transferId: transferKey,
    mediaId: '',
    status: 'pending',
  };
  appendMessage(msg);
  onChange?.();

  const host = String(peerMeta.host || offer.hostHint || '')
    .replace(/^::ffff:/, '')
    .replace(/^::1$/, '127.0.0.1');
  const httpPort = Number(offer.httpPort) || Number(peerMeta.httpPort) || HTTP_PORT;
  if (!host) {
    updateMessage(offer.groupId, offer.msgId, { status: 'failed' });
    onChange?.();
    return;
  }

  downloading.add(transferKey);
  try {
    const mediaId = await downloadTransfer({
      host,
      httpPort,
      transferId: transferKey,
      fileName: offer.fileName,
      expectedSize: Number(offer.size) || 0,
    });
    updateMessage(offer.groupId, offer.msgId, { mediaId, status: 'complete' });
    sendSignal?.(
      {
        type: 'file-ack',
        transferId: transferKey,
        msgId: offer.msgId,
        groupId: offer.groupId,
        fromId: state.clientId,
      },
      offer.fromId
    );
  } catch (e) {
    console.error('[lan-mesh] file download failed', e);
    updateMessage(offer.groupId, offer.msgId, { status: 'failed' });
  } finally {
    downloading.delete(transferKey);
  }
  onChange?.();
}

async function downloadTransfer({ host, httpPort, transferId, fileName, expectedSize }) {
  if (expectedSize > MAX_FILE_BYTES) throw new Error('文件过大');
  const url = `http://${host}:${httpPort}/file/${encodeURIComponent(transferId)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5 * 60 * 1000);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('空响应');
    if (buf.length > MAX_FILE_BYTES) throw new Error('文件过大');
    const ext = path.extname(String(fileName || '')) || '';
    const mediaId = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    const dest = path.join(mediaDir(), mediaId);
    fs.writeFileSync(dest, buf);
    return mediaId;
  } finally {
    clearTimeout(timer);
  }
}

export function openLocalMedia(mediaId) {
  const full = resolveMediaPath(mediaId);
  if (!full || !fs.existsSync(full)) throw new Error('文件不存在');
  return full;
}

export { MAX_FILE_BYTES, chatWire };
