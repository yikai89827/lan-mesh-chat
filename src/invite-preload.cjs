const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meshInvite', {
  getInvite: () => ipcRenderer.invoke('mesh:invite-get'),
  respond: (accepted) => ipcRenderer.invoke('mesh:invite-respond', { accepted: !!accepted }),
});
