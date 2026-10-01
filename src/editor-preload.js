const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('narc', {
  init: () => ipcRenderer.invoke('edit:init'),
  read: (position, length) => ipcRenderer.invoke('edit:read', position, length),
  state: (edits, dirty) => ipcRenderer.send('edit:state', edits, dirty),
  openOutput: () => ipcRenderer.invoke('edit:open-output'),
  write: (position, data) => ipcRenderer.send('edit:write', position, data),
  finishOutput: (keep) => ipcRenderer.invoke('edit:finish-output', keep),
  copy: () => ipcRenderer.invoke('edit:copy'),
  discard: () => ipcRenderer.send('edit:discard'),
  reveal: () => ipcRenderer.send('edit:reveal'),
  close: () => ipcRenderer.send('edit:close'),
  onBusy: (cb) => ipcRenderer.on('edit:busy', () => cb()),
});
