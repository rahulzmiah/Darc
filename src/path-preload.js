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
  onDock: (cb) => ipcRenderer.on('path:dock', (_e, data) => cb(data)),
  onDrive: (cb) => ipcRenderer.on('path:drive', (_e, d) => cb(d)),
  onUpdate: (cb) => ipcRenderer.on('path:update', (_e, p) => cb(p)),
  onSelect: (cb) => ipcRenderer.on('path:select', (_e, i) => cb(i)),
  onSpans: (cb) => ipcRenderer.on('path:spans', (_e, spans) => cb(spans)),
  dockSeek: (t) => ipcRenderer.send('tl:dock-seek', t),
  dockSelect: (i) => ipcRenderer.send('tl:dock-select', i),
  dockKey: (key, shift) => ipcRenderer.send('tl:dock-key', key, !!shift),
  menu: (items) => ipcRenderer.invoke('ctx:menu', items),
});
