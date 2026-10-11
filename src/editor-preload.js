const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('narc', {
  init: () => ipcRenderer.invoke('edit:init'),
  read: (position, length) => ipcRenderer.invoke('edit:read', position, length),
  state: (edits, dirty) => ipcRenderer.send('edit:state', edits, dirty),
  openOutput: () => ipcRenderer.invoke('edit:open-output'),
  write: (position, data) => ipcRenderer.send('edit:write', position, data),
  finishOutput: (keep) => ipcRenderer.invoke('edit:finish-output', keep),
  copy: () => ipcRenderer.invoke('edit:copy'),
  cursorLibrary: () => ipcRenderer.invoke('cursor:library'),
  discard: () => ipcRenderer.send('edit:discard'),
  reveal: () => ipcRenderer.send('edit:reveal'),
  close: () => ipcRenderer.send('edit:close'),
  onBusy: (cb) => ipcRenderer.on('edit:busy', () => cb()),
  animSet: (key, stops) => ipcRenderer.send('edit:anim-set', key, stops),
  pathSet: (key, path) => ipcRenderer.send('edit:path-set', key, path),
  pathDelete: (key) => ipcRenderer.send('edit:path-delete', key),
  rerecord: (plan) => ipcRenderer.send('edit:rerecord', plan),
  onTrack: (cb) => ipcRenderer.on('anim:track', (_e, data) => cb(data)),
  onPath: (cb) => ipcRenderer.on('anim:path', (_e, data) => cb(data)),
  menu: (items) => ipcRenderer.invoke('ctx:menu', items),
});
