/**
 * HTTP：发现 + 入群邀请（弹窗同意）+ 文件直传
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  HTTP_PORT,
  getHelloPayload,
  loadState,
  upsertGroup,
  ensureClientId,
  resolveMediaPath,
  guessMimeByName,
} from './store.mjs';
import { getOutboundTransfer, pruneTransfers } from './file-transfer.mjs';

/** @type {http.Server | null} */
let server = null;
/** @type {((invite: object) => void) | null} */
let onInvite = null;
/** @type {((group: object) => void) | null} */
let onJoined = null;
/** @type {(() => void) | null} */
let onInviteSettled = null;

/**
 * @type {{
 *   inviteId: string,
 *   invite: object,
 *   status: 'pending'|'accepted'|'rejected'|'timeout',
 *   consumed: boolean,
 *   expiresAt: number,
 *   timer: ReturnType<typeof setTimeout>|null,
 * } | null}
 */
let inviteSession = null;

const INVITE_WAIT_MS = 10 * 60 * 1000;

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(data);
}

function remoteHost(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  return String(req.socket?.remoteAddress || '')
    .replace(/^::ffff:/, '')
    .replace(/^::1$/, '127.0.0.1');
}

function clearTimer() {
  if (inviteSession?.timer) {
    clearTimeout(inviteSession.timer);
    inviteSession.timer = null;
  }
}

function expireInvite() {
  if (!inviteSession || inviteSession.status !== 'pending') return;
  inviteSession.status = 'timeout';
  inviteSession.timer = null;
  onInviteSettled?.();
}

export function respondToInvite(accepted) {
  if (!inviteSession || inviteSession.status !== 'pending') {
    return { ok: false, error: '没有待处理的入群邀请' };
  }
  clearTimer();
  if (!accepted) {
    inviteSession.status = 'rejected';
    return { ok: true };
  }

  const inv = inviteSession.invite;
  const state = ensureClientId();
  const self = { clientId: state.clientId, name: state.name, host: '' };
  const members = Array.isArray(inv.members) ? inv.members : [];
  const group = {
    id: inv.groupId,
    name: inv.groupName,
    kind: inv.kind === 'dm' || String(inv.groupId).startsWith('dm-') ? 'dm' : 'group',
    createdBy: inv.fromId,
    createdAt: inv.groupCreatedAt || Date.now(),
    members: mergeUnique([...members, self, { clientId: inv.fromId, name: inv.fromName, host: inv.fromHost }]),
  };
  upsertGroup(group);
  inviteSession.status = 'accepted';
  onJoined?.(group);
  return { ok: true, group };
}

function mergeUnique(list) {
  const map = new Map();
  for (const m of list) {
    if (!m?.clientId) continue;
    map.set(m.clientId, {
      clientId: String(m.clientId),
      name: String(m.name || ''),
      host: String(m.host || ''),
    });
  }
  return [...map.values()];
}

export function getPendingInvite() {
  if (inviteSession?.status === 'pending') {
    return { ...inviteSession.invite, inviteId: inviteSession.inviteId };
  }
  return null;
}

export function clearInviteSession() {
  clearTimer();
  inviteSession = null;
  onInviteSettled?.();
}

/**
 * @param {{
 *   onInvite?: (invite: object) => void,
 *   onJoined?: (group: object) => void,
 *   onInviteSettled?: () => void,
 * }} [opts]
 */
export function startPeerHttp(opts = {}) {
  onInvite = opts.onInvite || onInvite;
  onJoined = opts.onJoined || onJoined;
  onInviteSettled = opts.onInviteSettled || onInviteSettled;
  if (server) return server;

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {});
      return;
    }

    if (req.method === 'GET' && url.pathname === '/hello') {
      sendJson(res, 200, getHelloPayload());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/invite-status') {
      const inviteId = String(url.searchParams.get('inviteId') || '').trim();
      if (!inviteSession || !inviteId || inviteSession.inviteId !== inviteId) {
        sendJson(res, 200, { status: 'idle' });
        return;
      }
      if (inviteSession.status === 'pending' && Date.now() > inviteSession.expiresAt) {
        expireInvite();
      }
      const status = inviteSession.status;
      const payload = {
        status,
        inviteId: inviteSession.inviteId,
        groupId: inviteSession.invite?.groupId,
      };
      if (status !== 'pending' && !inviteSession.consumed) {
        inviteSession.consumed = true;
        const done = inviteSession;
        setTimeout(() => {
          if (inviteSession === done) inviteSession = null;
        }, 5000);
      }
      sendJson(res, 200, payload);
      return;
    }

    // 本机聊天窗预览媒体（仅服务 userData/media）
    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      const mediaId = decodeURIComponent(url.pathname.slice('/media/'.length));
      const full = resolveMediaPath(mediaId);
      if (!full || !fs.existsSync(full)) {
        sendJson(res, 404, { error: 'media not found' });
        return;
      }
      try {
        const data = fs.readFileSync(full);
        res.writeHead(200, {
          'Content-Type': guessMimeByName(mediaId),
          'Content-Length': data.length,
          'Cache-Control': 'private, max-age=3600',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/file/')) {
      pruneTransfers();
      const transferId = decodeURIComponent(url.pathname.slice('/file/'.length));
      const row = getOutboundTransfer(transferId);
      if (!row || !row.filePath || !fs.existsSync(row.filePath)) {
        sendJson(res, 404, { error: 'transfer not found' });
        return;
      }
      try {
        const data = fs.readFileSync(row.filePath);
        const safeName = path.basename(row.fileName || 'file').replace(/[^\w.\-\u4e00-\u9fff]/g, '_');
        res.writeHead(200, {
          'Content-Type': row.mime || 'application/octet-stream',
          'Content-Length': data.length,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/invite') {
      try {
        const body = await readJson(req);
        const state = loadState();
        if (!state.name || !state.clientId) {
          sendJson(res, 400, { error: '对方尚未设置花名' });
          return;
        }
        const fromId = String(body.fromId || '').trim();
        if (!fromId) {
          sendJson(res, 400, { error: '邀请方信息不完整' });
          return;
        }
        if (fromId === state.clientId) {
          sendJson(res, 400, { error: '不能邀请本机' });
          return;
        }
        const groupId = String(body.groupId || '').trim();
        const groupName = String(body.groupName || '').trim();
        if (!groupId || !groupName) {
          sendJson(res, 400, { error: '群信息不完整' });
          return;
        }

        if (inviteSession?.status === 'pending') {
          if (inviteSession.invite?.groupId === groupId && inviteSession.invite?.fromId === fromId) {
            onInvite?.({ ...inviteSession.invite, inviteId: inviteSession.inviteId });
            sendJson(res, 200, {
              ok: true,
              pending: true,
              reused: true,
              inviteId: inviteSession.inviteId,
            });
            return;
          }
          sendJson(res, 409, { error: '对方正在确认另一条入群邀请' });
          return;
        }

        const fromHost =
          String(body.fromHost || '').trim() ||
          remoteHost(req);
        const inviteId = crypto.randomBytes(8).toString('hex');
        const invite = {
          inviteId,
          groupId,
          groupName,
          kind: body.kind === 'dm' ? 'dm' : 'group',
          groupCreatedAt: Number(body.groupCreatedAt) || Date.now(),
          fromId,
          fromName: String(body.fromName || ''),
          fromHost,
          fromWsPort: Number(body.fromWsPort) || 17902,
          members: Array.isArray(body.members) ? body.members : [],
          requestedAt: Date.now(),
        };

        clearTimer();
        inviteSession = {
          inviteId,
          invite,
          status: 'pending',
          consumed: false,
          expiresAt: Date.now() + INVITE_WAIT_MS,
          timer: setTimeout(() => expireInvite(), INVITE_WAIT_MS),
        };
        onInvite?.(invite);
        sendJson(res, 200, { ok: true, pending: true, inviteId });
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });

  server.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`[lan-mesh] HTTP http://0.0.0.0:${HTTP_PORT}/hello`);
  });
  server.on('error', (err) => {
    console.error('[lan-mesh] HTTP failed', err);
  });
  return server;
}

export function stopPeerHttp() {
  clearInviteSession();
  if (!server) return;
  try {
    server.close();
  } catch {
    /* ignore */
  }
  server = null;
}
