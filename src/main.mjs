/**
 * LAN Mesh Chat — Electron 主进程
 */
import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import {
  HTTP_PORT,
  WS_PORT,
  ensureClientId,
  setIdentity,
  createGroup,
  addMemberToGroup,
  getMessages,
  getGroup,
  upsertGroup,
  getOrCreateDm,
  isDmGroup,
  resolveMediaPath,
  markGroupRead,
  getUnreadCounts,
  loadFlavor,
} from './store.mjs';

import { scanPeers, invitePeer, waitInviteDecision } from './discovery.mjs';
import {
  startPeerHttp,
  respondToInvite,
  getPendingInvite,
} from './peer-http.mjs';
import {
  startMesh,
  connectToPeer,
  connectKnownMembers,
  publishChat,
  announceGroup,
  getMeshStatus,
  meshSendSignal,
} from './mesh.mjs';
import { initFileTransfer, publishFile, openLocalMedia } from './file-transfer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLAVOR = loadFlavor();
const APP_TITLE = FLAVOR.label ? `LAN Mesh Chat (${FLAVOR.label})` : 'LAN Mesh Chat';
const APP_ICON = path.join(__dirname, 'ui', 'icon.png');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'meshmedia',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let inviteWindow = null;
/** @type {object | null} */
let invitePayload = null;

function broadcastChanged() {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('mesh:changed');
    } catch {
      /* ignore */
    }
  }
}

function localLanIps() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces || {})) {
    for (const item of list || []) {
      if (!item || item.internal) continue;
      if (item.family !== 'IPv4' && item.family !== 4) continue;
      const addr = String(item.address || '');
      if (addr && !addr.startsWith('169.254.')) out.push(addr);
    }
  }
  return out;
}

function openMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    title: APP_TITLE,
    icon: APP_ICON,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
}

function closeInviteWindow() {
  invitePayload = null;
  if (inviteWindow && !inviteWindow.isDestroyed()) {
    try {
      inviteWindow.destroy();
    } catch {
      /* ignore */
    }
  }
  inviteWindow = null;
}

function openInviteWindow(invite) {
  if (inviteWindow && !inviteWindow.isDestroyed()) {
    try {
      invitePayload = null;
      inviteWindow.destroy();
    } catch {
      /* ignore */
    }
    inviteWindow = null;
  }
  invitePayload = invite || null;
  const isDm = invite?.kind === 'dm' || String(invite?.groupId || '').startsWith('dm-');
  inviteWindow = new BrowserWindow({
    width: 460,
    height: 400,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    alwaysOnTop: true,
    title: isDm ? '私聊请求' : '入群邀请',
    icon: APP_ICON,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'invite-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  inviteWindow.setMenuBarVisibility(false);
  inviteWindow.setAlwaysOnTop(true, 'screen-saver');
  inviteWindow.loadFile(path.join(__dirname, 'ui', 'invite.html'));
  inviteWindow.on('close', (e) => {
    if (invitePayload) e.preventDefault();
  });
  inviteWindow.on('closed', () => {
    inviteWindow = null;
  });
  inviteWindow.once('ready-to-show', () => {
    try {
      inviteWindow.show();
      inviteWindow.focus();
      inviteWindow.moveTop();
    } catch {
      /* ignore */
    }
  });
  try {
    inviteWindow.show();
    inviteWindow.focus();
  } catch {
    /* ignore */
  }
  return inviteWindow;
}

function registerIpc() {
  ipcMain.handle('mesh:get-state', () => {
    const state = ensureClientId();
    return {
      identity: { clientId: state.clientId, name: state.name },
      groups: state.groups,
      ports: { http: HTTP_PORT, ws: WS_PORT },
      mesh: getMeshStatus(),
      pendingInvite: getPendingInvite(),
      localIps: localLanIps(),
      unread: getUnreadCounts(),
      flavor: FLAVOR,
      appTitle: APP_TITLE,
    };
  });

  ipcMain.handle('mesh:mark-read', (_e, { groupId, ts } = {}) => {
    markGroupRead(groupId, ts || Date.now());
    return getUnreadCounts();
  });

  ipcMain.handle('mesh:set-identity', (_e, { name } = {}) => {
    const next = setIdentity(name);
    broadcastChanged();
    void connectKnownMembers();
    return next;
  });

  ipcMain.handle('mesh:scan', async (_e, { extraPorts = [] } = {}) => {
    const self = ensureClientId();
    const res = await scanPeers({
      includeLocalhost: true,
      extraPorts: Array.isArray(extraPorts) ? extraPorts : [],
    });
    const peers = (res.peers || []).filter((p) => p.clientId !== self.clientId);
    for (const p of peers) {
      if (p.host) connectToPeer(p.host, p.wsPort);
    }
    return { ...res, peers };
  });

  ipcMain.handle('mesh:create-group', async (_e, { name, invitees = [] } = {}) => {
    const state = ensureClientId();
    if (!state.name) throw new Error('请先设置花名');
    const next = createGroup({ name, members: [] });
    const group = next.groups[next.groups.length - 1];
    announceGroup(group);
    broadcastChanged();

    const results = [];
    for (const inv of invitees || []) {
      if (!inv?.host || !inv?.clientId) continue;
      try {
        const r = await inviteOne(group, inv);
        results.push({ ...r, clientId: inv.clientId, name: inv.name, ok: true });
      } catch (e) {
        results.push({
          clientId: inv.clientId,
          name: inv.name,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { group: getGroup(group.id), results };
  });

  ipcMain.handle('mesh:open-dm', async (_e, peer = {}) => {
    const state = ensureClientId();
    if (!state.name) throw new Error('请先设置花名');
    if (!peer?.clientId) throw new Error('请选择邻居');
    const { group } = getOrCreateDm(peer);
    const ips = localLanIps();
    const selfHost =
      String(peer.host || '') === '127.0.0.1' ? '127.0.0.1' : ips[0] || '';
    addMemberToGroup(group.id, {
      clientId: state.clientId,
      name: state.name,
      host: selfHost,
      httpPort: HTTP_PORT,
      wsPort: WS_PORT,
    });
    const updated = getGroup(group.id);
    if (peer.host) connectToPeer(peer.host, peer.wsPort || WS_PORT);
    if (updated) announceGroup(updated);
    broadcastChanged();
    return { group: updated || group };
  });

  ipcMain.handle('mesh:invite', async (_e, { groupId, invitees = [] } = {}) => {
    const group = getGroup(groupId);
    if (!group) throw new Error('群不存在');
    if (isDmGroup(group)) throw new Error('私聊无需邀请入群');
    const results = [];
    for (const inv of invitees || []) {
      if (!inv?.host || !inv?.clientId) continue;
      try {
        const r = await inviteOne(group, inv);
        results.push({ ...r, clientId: inv.clientId, name: inv.name, ok: true });
      } catch (e) {
        results.push({
          clientId: inv.clientId,
          name: inv.name,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { group: getGroup(groupId), results };
  });

  ipcMain.handle('mesh:messages', (_e, { groupId } = {}) => {
    return getMessages(groupId, 300);
  });

  ipcMain.handle('mesh:send', (_e, { groupId, text } = {}) => {
    const msg = publishChat({ groupId, text });
    broadcastChanged();
    return msg;
  });

  ipcMain.handle('mesh:pick-and-send-file', async (_e, { groupId, imagesOnly = false } = {}) => {
    if (!groupId) throw new Error('未选择会话');
    /** 仅选图片时限制类型；选文件不设 filters，可选任意类型 */
    const opts = {
      title: imagesOnly ? '选择图片' : '选择文件',
      properties: ['openFile'],
    };
    if (imagesOnly) {
      opts.filters = [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tif', 'tiff'] },
      ];
    }
    const res = await dialog.showOpenDialog(mainWindow || undefined, opts);
    if (res.canceled || !res.filePaths?.[0]) return { canceled: true };
    const filePath = res.filePaths[0];
    const msg = publishFile({
      groupId,
      filePath,
      fileName: path.basename(filePath),
    });
    broadcastChanged();
    return { canceled: false, msg };
  });

  ipcMain.handle('mesh:send-file-path', (_e, { groupId, filePath, fileName } = {}) => {
    const msg = publishFile({ groupId, filePath, fileName });
    broadcastChanged();
    return msg;
  });

  ipcMain.handle('mesh:send-paste-image', async (_e, { groupId, mime, base64, fileName } = {}) => {
    if (!groupId) throw new Error('未选择会话');
    const raw = String(base64 || '');
    if (!raw) throw new Error('没有图片数据');
    const buf = Buffer.from(raw, 'base64');
    if (!buf.length) throw new Error('图片数据无效');
    if (buf.length > 80 * 1024 * 1024) throw new Error('图片过大');
    const ext =
      String(mime || '').includes('jpeg') || String(mime || '').includes('jpg')
        ? '.jpg'
        : String(mime || '').includes('gif')
          ? '.gif'
          : String(mime || '').includes('webp')
            ? '.webp'
            : '.png';
    const tmp = path.join(app.getPath('temp'), `lan-mesh-paste-${Date.now()}${ext}`);
    fs.writeFileSync(tmp, buf);
    try {
      const msg = publishFile({
        groupId,
        filePath: tmp,
        fileName: fileName || `paste${ext}`,
      });
      broadcastChanged();
      return msg;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  });

  ipcMain.handle('mesh:open-media', async (_e, { mediaId } = {}) => {
    const full = openLocalMedia(mediaId);
    await shell.openPath(full);
    return { ok: true, path: full };
  });

  ipcMain.handle('mesh:reveal-media', async (_e, { mediaId } = {}) => {
    const full = openLocalMedia(mediaId);
    shell.showItemInFolder(full);
    return { ok: true, path: full };
  });

  ipcMain.handle('mesh:forward-message', async (_e, { targetGroupId, message } = {}) => {
    if (!targetGroupId) throw new Error('未选择目标会话');
    if (!getGroup(targetGroupId)) throw new Error('目标会话不存在');
    const m = message || {};
    const kind = m.kind === 'image' || m.kind === 'file' ? m.kind : 'text';

    if (kind === 'text') {
      const text = String(m.text || '').trim();
      if (!text) throw new Error('没有可转发的文字');
      const msg = publishChat({ groupId: targetGroupId, text });
      broadcastChanged();
      return { ok: true, msg };
    }

    if (!m.mediaId) throw new Error('文件尚未就绪，无法转发');
    const full = openLocalMedia(m.mediaId);
    const msg = publishFile({
      groupId: targetGroupId,
      filePath: full,
      fileName: m.fileName || path.basename(full),
    });
    broadcastChanged();
    return { ok: true, msg };
  });

  ipcMain.handle('mesh:media-url', (_e, { mediaId } = {}) => {
    const full = resolveMediaPath(mediaId);
    if (!full || !fs.existsSync(full)) return null;
    // 用本机 HTTP 提供预览，比自定义协议更稳（img 可直接加载）
    return `http://127.0.0.1:${HTTP_PORT}/media/${encodeURIComponent(mediaId)}?t=${Date.now()}`;
  });

  ipcMain.handle('mesh:connect-peer', (_e, { host, wsPort } = {}) => {
    connectToPeer(host, wsPort);
    return getMeshStatus();
  });

  ipcMain.handle('mesh:invite-get', () => invitePayload || getPendingInvite());

  ipcMain.handle('mesh:invite-respond', (_e, { accepted } = {}) => {
    const result = respondToInvite(!!accepted);
    closeInviteWindow();
    if (accepted && result.group) {
      announceGroup(result.group);
      for (const m of result.group.members || []) {
        if (m.host) connectToPeer(m.host);
      }
    }
    broadcastChanged();
    return result;
  });
}

async function inviteOne(group, peer) {
  const state = ensureClientId();
  const ips = localLanIps();
  const fromHost =
    String(peer.host || '') === '127.0.0.1' ? '127.0.0.1' : ips[0] || '';
  const body = {
    groupId: group.id,
    groupName: group.name,
    kind: group.kind || 'group',
    groupCreatedAt: group.createdAt,
    fromId: state.clientId,
    fromName: state.name,
    fromHost,
    fromWsPort: WS_PORT,
    members: group.members,
  };
  const peerHttp = Number(peer.httpPort) || HTTP_PORT;
  const claim = await invitePeer(peer.host, body, 8000, peerHttp);
  if (!claim?.pending || !claim?.inviteId) {
    throw new Error(claim?.error || '对方未进入确认流程');
  }
  await waitInviteDecision(peer.host, claim.inviteId, {
    timeoutMs: 10 * 60 * 1000,
    intervalMs: 1000,
    httpPort: peerHttp,
  });
  addMemberToGroup(group.id, {
    clientId: peer.clientId,
    name: peer.name || '',
    host: peer.host,
    httpPort: peerHttp,
    wsPort: peer.wsPort || WS_PORT,
  });
  const updated = getGroup(group.id);
  if (updated) {
    upsertGroup(updated);
    announceGroup(updated);
  }
  connectToPeer(peer.host, peer.wsPort || WS_PORT);
  broadcastChanged();
  return { inviteId: claim.inviteId };
}

app.whenReady().then(() => {
  protocol.handle('meshmedia', (request) => {
    try {
      const u = new URL(request.url);
      const mediaId = decodeURIComponent((u.pathname || '').replace(/^\//, ''));
      const full = resolveMediaPath(mediaId);
      if (!full || !fs.existsSync(full)) {
        return new Response('not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(full).href);
    } catch {
      return new Response('bad request', { status: 400 });
    }
  });

  ensureClientId();
  initFileTransfer({
    onChange: broadcastChanged,
    sendSignal: (obj, peerClientId) => meshSendSignal(obj, peerClientId),
    connectPeer: (host, wsPort) => connectToPeer(host, wsPort),
  });
  registerIpc();
  startPeerHttp({
    onInvite: (invite) => {
      openInviteWindow(invite);
      broadcastChanged();
    },
    onJoined: (group) => {
      if (invitePayload?.fromHost) {
        connectToPeer(invitePayload.fromHost, invitePayload.fromWsPort || WS_PORT);
      }
      for (const m of group.members || []) {
        if (m.host) connectToPeer(m.host);
      }
      broadcastChanged();
    },
    onInviteSettled: () => {
      closeInviteWindow();
      broadcastChanged();
    },
  });
  startMesh({ onChange: broadcastChanged });
  void connectKnownMembers();
  openMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
