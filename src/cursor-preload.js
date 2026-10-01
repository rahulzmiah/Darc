const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('narc', {
  init: () => ipcRenderer.invoke('live:init'),
  input: (ev) => ipcRenderer.send('live:input', ev),
  onPointer: (cb) => ipcRenderer.on('live:pointer', (_e, p) => cb(p)),
  onCursorImage: (cb) => ipcRenderer.on('live:cursor-image', (_e, img) => cb(img)),
  onCursor: (cb) => ipcRenderer.on('live:cursor', (_e, c) => cb(c)),
  onCursorSpans: (cb) => ipcRenderer.on('live:cursor-spans', (_e, spans) => cb(spans)),
  onAnimProgress: (cb) => ipcRenderer.on('live:anim-progress', (_e, p) => cb(p)),
});
