// The overlay page's only way out: receive the tracker's numbers, send the buttons and the menu back.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onStats: fn => ipcRenderer.on('stats', (_e, s) => fn(s)),
  cmd: c => ipcRenderer.send('cmd', c),
  stop: () => ipcRenderer.send('stop'),
  menu: () => ipcRenderer.send('menu'),
  close: () => ipcRenderer.send('close'),
  onUpdate: fn => ipcRenderer.on('update', (_e, v) => fn(v)),
  onUpdating: fn => ipcRenderer.on('updating', (_e, v) => fn(v)),
  onNotice: fn => ipcRenderer.on('notice', (_e, v) => fn(v)),
  installUpdate: () => ipcRenderer.send('install-update'),
  openTracker: () => ipcRenderer.send('open-tracker'),
});
