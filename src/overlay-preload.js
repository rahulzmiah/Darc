const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('narc', {
  navigate: (input) => ipcRenderer.send('navigate', input),
  hide: () => ipcRenderer.send('overlay:hide'),
  setSettings: (partial) => ipcRenderer.send('settings:set', partial),
  resetSettings: () => ipcRenderer.send('settings:reset'),
  onShow: (cb) => ipcRenderer.on('overlay:show', (_e, data) => cb(data)),
  onSettings: (cb) => ipcRenderer.on('overlay:settings', (_e, s) => cb(s)),
});
