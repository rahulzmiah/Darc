const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('narc', {
  load: () => ipcRenderer.invoke('anim:load'),
  save: (key, stops, cursor) => ipcRenderer.send('anim:set', { key, stops, cursor }),
  savePath: (key, path) => ipcRenderer.send('tl:path-set', key, path),
  deletePath: (key) => ipcRenderer.send('tl:path-delete', key),
  drive: (t) => ipcRenderer.send('anim:drive', t),
  play: () => ipcRenderer.send('anim:play'),
  stop: () => ipcRenderer.send('anim:stop'),
  selectAnchor: (i) => ipcRenderer.send('tl:select-anchor', i),
  close: () => ipcRenderer.send('tl:close'),
  resize: (height) => ipcRenderer.send('tl:resize', height),
  onTrack: (cb) => ipcRenderer.on('anim:track', (_e, data) => cb(data)),
  onPath: (cb) => ipcRenderer.on('anim:path', (_e, data) => cb(data)),
  onPageChanged: (cb) => ipcRenderer.on('anim:page-changed', () => cb()),
  onProgress: (cb) => ipcRenderer.on('anim:progress', (_e, data) => cb(data)),
  onPreview: (cb) => ipcRenderer.on('tl:preview', () => cb()),
  onDockSeek: (cb) => ipcRenderer.on('tl:dock-seek', (_e, t) => cb(t)),
  onDockSelect: (cb) => ipcRenderer.on('tl:dock-select', (_e, i) => cb(i)),
  onDockKey: (cb) => ipcRenderer.on('tl:dock-key', (_e, key, shift) => cb(key, shift)),
  menu: (items) => ipcRenderer.invoke('ctx:menu', items),
});
