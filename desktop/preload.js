// The overlay page's only way out: receive the tracker's numbers, send the buttons and the menu back.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onStats: fn => ipcRenderer.on('stats', (_e, s) => fn(s)),
  cmd: c => ipcRenderer.send('cmd', c),
  menu: () => ipcRenderer.send('menu'),
  close: () => ipcRenderer.send('close'),
  openTracker: () => ipcRenderer.send('open-tracker'),
});
