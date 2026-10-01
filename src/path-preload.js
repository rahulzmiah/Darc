const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('narc', {
  onOpen: (cb) => ipcRenderer.on('path:open', (_e, data) => cb(data)),
  onStop: (cb) => ipcRenderer.on('path:stop', () => cb()),
  onPointer: (cb) => ipcRenderer.on('path:pointer', (_e, p) => cb(p)),
  onCursorImage: (cb) => ipcRenderer.on('path:cursor-image', (_e, img) => cb(img)),
  input: (ev) => ipcRenderer.send('path:input', ev),
  scroll: (y) => ipcRenderer.send('path:scroll', y),
  progress: (p) => ipcRenderer.send('path:progress', p),
  save: (key, path) => ipcRenderer.send('path:set', key, path),
  remove: (key) => ipcRenderer.send('path:delete', key),
  close: () => ipcRenderer.send('path:close'),
});
