/**
 * 本机身份 / 群 / 私聊 / 消息持久化
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 打包时写入的 flavor（default / alt），开发时可用 CLI / 环境变量覆盖 */
export function loadFlavor() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'flavor.json'), 'utf8');
    const data = JSON.parse(raw);
    return {
      id: String(data?.id || 'default'),
      meshOffset: Number(data?.meshOffset) || 0,
      label: String(data?.label || ''),
    };
  } catch {
    return { id: 'default', meshOffset: 0, label: '' };
  }
}

function portOffset() {
  const env = Number(process.env.LAN_MESH_PORT_OFFSET || 0);
  if (Number.isFinite(env) && env > 0) return env;
  const arg = process.argv.find((a) => a.startsWith('--mesh-offset='));
  if (arg) {
    const n = Number(arg.slice('--mesh-offset='.length));
    if (Number.isFinite(n) && n > 0) return n;
  }
  const flavor = loadFlavor();
  if (Number.isFinite(flavor.meshOffset) && flavor.meshOffset > 0) return flavor.meshOffset;
  return 0;
}

const OFFSET = portOffset();
/** 默认 17901；本机第二实例可用 --mesh-offset=10 → 17911 */
export const HTTP_PORT = 17901 + OFFSET;
/** 默认 17902；第二实例 → 17912 */
export const WS_PORT = 17902 + OFFSET;
const MAX_MESSAGES_PER_GROUP = 500;

function storePath() {
  return path.join(app.getPath('userData'), 'lan-mesh-state.json');
}

export function mediaDir() {
  const dir = path.join(app.getPath('userData'), 'media');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveMediaPath(mediaId) {
  const id = String(mediaId || '').replace(/[/\\]/g, '');
  if (!id || id.includes('..')) return null;
  const full = path.join(mediaDir(), id);
  const root = path.resolve(mediaDir());
  if (!path.resolve(full).startsWith(root)) return null;
  return full;
}

function emptyState() {
  return {
    clientId: '',
    name: '',
    /** @type {Array<{ id: string, name: string, kind?: 'group'|'dm', createdBy: string, createdAt: number, members: Array<{ clientId: string, name: string, host?: string, httpPort?: number, wsPort?: number }> }>} */
    groups: [],
    /** @type {Record<string, Array<object>>} */
    messages: {},
    /** @type {Record<string, number>} 各会话已读到的时间戳 */
    readAt: {},
    updatedAt: 0,
  };
}

export function loadState() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return emptyState();
    const base = emptyState();
    return {
      ...base,
      ...data,
      clientId: typeof data.clientId === 'string' ? data.clientId : '',
      name: typeof data.name === 'string' ? data.name : '',
      groups: Array.isArray(data.groups) ? data.groups : [],
      messages: data.messages && typeof data.messages === 'object' ? data.messages : {},
      readAt: data.readAt && typeof data.readAt === 'object' ? data.readAt : {},
    };
  } catch {
    return emptyState();
  }
}

export function saveState(state) {
  const next = { ...emptyState(), ...state, updatedAt: Date.now() };
  if (!next.clientId) next.clientId = randomBytes(8).toString('hex');
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export function ensureClientId() {
  const state = loadState();
  if (state.clientId) return state;
  return saveState({ ...state, clientId: randomBytes(8).toString('hex') });
}

export function setIdentity(name) {
  const state = ensureClientId();
  const n = String(name || '').trim();
  if (!n) throw new Error('请填写花名');
  return saveState({ ...state, name: n });
}

function normalizeMember(m) {
  return {
    clientId: String(m?.clientId || ''),
    name: String(m?.name || ''),
    host: String(m?.host || ''),
    httpPort: Number(m?.httpPort) || 0,
    wsPort: Number(m?.wsPort) || 0,
  };
}

export function createGroup({ name, members = [], kind = 'group' } = {}) {
  const state = ensureClientId();
  if (!state.name) throw new Error('请先设置花名');
  const groupName = String(name || '').trim();
  if (!groupName) throw new Error('请填写群名称');
  const id = randomBytes(8).toString('hex');
  const self = {
    clientId: state.clientId,
    name: state.name,
    host: '',
    httpPort: HTTP_PORT,
    wsPort: WS_PORT,
  };
  const others = (members || [])
    .filter((m) => m?.clientId && m.clientId !== state.clientId)
    .map(normalizeMember);
  const group = {
    id,
    name: groupName,
    kind: kind === 'dm' ? 'dm' : 'group',
    createdBy: state.clientId,
    createdAt: Date.now(),
    members: [self, ...others],
  };
  const groups = [...state.groups, group];
  const messages = { ...state.messages, [id]: [] };
  const readAt = { ...(state.readAt || {}), [id]: Date.now() };
  return saveState({ ...state, groups, messages, readAt });
}

/** 确定性私聊 id，双方一致 */
export function dmIdFor(clientIdA, clientIdB) {
  const a = String(clientIdA || '');
  const b = String(clientIdB || '');
  return `dm-${[a, b].sort().join('-')}`;
}

/**
 * 打开或创建与邻居的点对点私聊
 * @param {{ clientId: string, name?: string, host?: string, httpPort?: number, wsPort?: number }} peer
 */
export function getOrCreateDm(peer) {
  const state = ensureClientId();
  if (!state.name) throw new Error('请先设置花名');
  const peerId = String(peer?.clientId || '').trim();
  if (!peerId || peerId === state.clientId) throw new Error('无效的私聊对象');

  const id = dmIdFor(state.clientId, peerId);
  const existing = state.groups.find((g) => g.id === id);
  const self = {
    clientId: state.clientId,
    name: state.name,
    host: '',
    httpPort: HTTP_PORT,
    wsPort: WS_PORT,
  };
  const other = normalizeMember({
    clientId: peerId,
    name: peer.name || '',
    host: peer.host || '',
    httpPort: peer.httpPort || HTTP_PORT,
    wsPort: peer.wsPort || WS_PORT,
  });

  if (existing) {
    const members = mergeMembers(existing.members, [self, other]);
    const groups = state.groups.map((g) =>
      g.id === id
        ? {
            ...g,
            kind: 'dm',
            name: other.name || existing.name || '私聊',
            members,
          }
        : g
    );
    return { state: saveState({ ...state, groups }), group: groups.find((g) => g.id === id), created: false };
  }

  const group = {
    id,
    name: other.name || '私聊',
    kind: 'dm',
    createdBy: state.clientId,
    createdAt: Date.now(),
    members: [self, other],
  };
  const groups = [...state.groups, group];
  const messages = { ...state.messages, [id]: [] };
  const readAt = { ...(state.readAt || {}), [id]: Date.now() };
  const next = saveState({ ...state, groups, messages, readAt });
  return { state: next, group, created: true };
}

export function upsertGroup(group) {
  const state = ensureClientId();
  if (!group?.id) return state;
  const groups = [...state.groups];
  const idx = groups.findIndex((g) => g.id === group.id);
  const kind = group.kind === 'dm' || String(group.id).startsWith('dm-') ? 'dm' : 'group';
  const normalized = {
    id: String(group.id),
    name: String(group.name || (kind === 'dm' ? '私聊' : '未命名群')),
    kind,
    createdBy: String(group.createdBy || ''),
    createdAt: Number(group.createdAt) || Date.now(),
    members: Array.isArray(group.members) ? group.members.map(normalizeMember) : [],
  };
  if (idx >= 0) {
    groups[idx] = {
      ...groups[idx],
      ...normalized,
      members: mergeMembers(groups[idx].members, normalized.members),
    };
  } else {
    groups.push(normalized);
  }
  const messages = { ...state.messages };
  if (!messages[normalized.id]) messages[normalized.id] = [];
  const readAt = { ...(state.readAt || {}) };
  if (readAt[normalized.id] == null) readAt[normalized.id] = Date.now();
  return saveState({ ...state, groups, messages, readAt });
}

function mergeMembers(a = [], b = []) {
  const map = new Map();
  for (const m of [...a, ...b]) {
    if (!m?.clientId) continue;
    const prev = map.get(m.clientId) || {};
    map.set(m.clientId, {
      clientId: m.clientId,
      name: m.name || prev.name || '',
      host: m.host || prev.host || '',
      httpPort: Number(m.httpPort) || Number(prev.httpPort) || 0,
      wsPort: Number(m.wsPort) || Number(prev.wsPort) || 0,
    });
  }
  return [...map.values()];
}

export function addMemberToGroup(groupId, member) {
  const state = loadState();
  const groups = state.groups.map((g) => {
    if (g.id !== groupId) return g;
    return { ...g, members: mergeMembers(g.members, [member]) };
  });
  return saveState({ ...state, groups });
}

export function getGroup(groupId) {
  return loadState().groups.find((g) => g.id === groupId) || null;
}

export function isDmGroup(group) {
  if (!group) return false;
  return group.kind === 'dm' || String(group.id || '').startsWith('dm-');
}

function normalizeMessage(msg) {
  const kind = ['image', 'file'].includes(msg.kind) ? msg.kind : 'text';
  return {
    msgId: String(msg.msgId),
    groupId: String(msg.groupId || ''),
    fromId: String(msg.fromId || ''),
    fromName: String(msg.fromName || ''),
    text: String(msg.text || ''),
    ts: Number(msg.ts) || Date.now(),
    kind,
    fileName: msg.fileName ? String(msg.fileName) : '',
    mime: msg.mime ? String(msg.mime) : '',
    size: Number(msg.size) || 0,
    transferId: msg.transferId ? String(msg.transferId) : '',
    mediaId: msg.mediaId ? String(msg.mediaId) : '',
    status: msg.status ? String(msg.status) : kind === 'text' ? 'complete' : 'pending',
  };
}

export function appendMessage(msg) {
  const state = loadState();
  const groupId = String(msg.groupId || '');
  if (!groupId || !msg.msgId) return { state, added: false };
  const list = [...(state.messages[groupId] || [])];
  if (list.some((m) => m.msgId === msg.msgId)) {
    return { state, added: false };
  }
  list.push(normalizeMessage(msg));
  list.sort((a, b) => a.ts - b.ts || a.msgId.localeCompare(b.msgId));
  while (list.length > MAX_MESSAGES_PER_GROUP) list.shift();
  const messages = { ...state.messages, [groupId]: list };
  return { state: saveState({ ...state, messages }), added: true };
}

/** 更新已有消息的媒体字段（如下载完成后写入 mediaId） */
export function updateMessage(groupId, msgId, patch) {
  const state = loadState();
  const gid = String(groupId || '');
  const mid = String(msgId || '');
  const list = [...(state.messages[gid] || [])];
  const idx = list.findIndex((m) => m.msgId === mid);
  if (idx < 0) return { state, updated: false };
  list[idx] = normalizeMessage({ ...list[idx], ...patch, msgId: mid, groupId: gid });
  const messages = { ...state.messages, [gid]: list };
  return { state: saveState({ ...state, messages }), updated: true, message: list[idx] };
}

export function getMessages(groupId, limit = 200) {
  const list = loadState().messages[groupId] || [];
  if (list.length <= limit) return list;
  return list.slice(-limit);
}

export function markGroupRead(groupId, ts = Date.now()) {
  const state = loadState();
  const gid = String(groupId || '');
  if (!gid) return state;
  const prev = Number(state.readAt?.[gid]) || 0;
  const nextTs = Math.max(prev, Number(ts) || Date.now());
  const readAt = { ...(state.readAt || {}), [gid]: nextTs };
  return saveState({ ...state, readAt });
}

/** 未读：对方发来且晚于 readAt 的消息数；无游标时不计历史 */
export function getUnreadCounts() {
  const state = loadState();
  const myId = state.clientId;
  /** @type {Record<string, number>} */
  const out = {};
  for (const g of state.groups || []) {
    if (state.readAt?.[g.id] == null) {
      out[g.id] = 0;
      continue;
    }
    const since = Number(state.readAt[g.id]) || 0;
    const list = state.messages[g.id] || [];
    out[g.id] = list.filter((m) => m.fromId && m.fromId !== myId && (Number(m.ts) || 0) > since).length;
  }
  return out;
}

export function guessMimeByName(fileName = '') {
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
  };
  return map[ext] || 'application/octet-stream';
}

export function getHelloPayload() {
  const state = ensureClientId();
  return {
    app: 'lan-mesh-chat',
    clientId: state.clientId,
    name: state.name || '',
    httpPort: HTTP_PORT,
    wsPort: WS_PORT,
    groups: state.groups.map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.kind || (String(g.id).startsWith('dm-') ? 'dm' : 'group'),
      memberCount: (g.members || []).length,
    })),
  };
}
