const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('narc', {
  load: () => ipcRenderer.invoke('anim:load'),
  capture: () => ipcRenderer.invoke('anim:capture'),
  save: (key, stops) => ipcRenderer.send('anim:set', { key, stops }),
  play: () => ipcRenderer.send('anim:play'),
  stop: () => ipcRenderer.send('anim:stop'),
  close: () => ipcRenderer.send('anim:close'),
  onPageChanged: (cb) => ipcRenderer.on('anim:page-changed', () => cb()),
  onAddStop: (cb) => ipcRenderer.on('anim:add-stop', (_e, data) => cb(data)),
  onProgress: (cb) => ipcRenderer.on('anim:progress', (_e, data) => cb(data)),
});
