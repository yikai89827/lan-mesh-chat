const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meshApi', {
  getState: () => ipcRenderer.invoke('mesh:get-state'),
  setIdentity: (name) => ipcRenderer.invoke('mesh:set-identity', { name }),
  scan: (payload) => ipcRenderer.invoke('mesh:scan', payload || {}),
  createGroup: (payload) => ipcRenderer.invoke('mesh:create-group', payload),
  openDm: (peer) => ipcRenderer.invoke('mesh:open-dm', peer),
  inviteToGroup: (payload) => ipcRenderer.invoke('mesh:invite', payload),
  getMessages: (groupId) => ipcRenderer.invoke('mesh:messages', { groupId }),
  markRead: (groupId, ts) => ipcRenderer.invoke('mesh:mark-read', { groupId, ts }),
  sendChat: (payload) => ipcRenderer.invoke('mesh:send', payload),
  pickAndSendFile: (payload) => ipcRenderer.invoke('mesh:pick-and-send-file', payload || {}),
  sendFilePath: (payload) => ipcRenderer.invoke('mesh:send-file-path', payload),
  sendPasteImage: (payload) => ipcRenderer.invoke('mesh:send-paste-image', payload),
  openMedia: (mediaId) => ipcRenderer.invoke('mesh:open-media', { mediaId }),
  revealMedia: (mediaId) => ipcRenderer.invoke('mesh:reveal-media', { mediaId }),
  forwardMessage: (payload) => ipcRenderer.invoke('mesh:forward-message', payload || {}),
  mediaUrl: (mediaId) => ipcRenderer.invoke('mesh:media-url', { mediaId }),
  connectPeer: (payload) => ipcRenderer.invoke('mesh:connect-peer', payload),
  onChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('mesh:changed', handler);
    return () => ipcRenderer.removeListener('mesh:changed', handler);
  },
});
