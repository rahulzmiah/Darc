const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('narc', {
  answer: (ok) => ipcRenderer.send('toast:answer', ok),
});
