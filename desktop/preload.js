// The overlay page's only way out: receive the tracker's numbers, send the buttons and the menu back.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onStats: fn => ipcRenderer.on('stats', (_e, s) => fn(s)),
  cmd: (c, v) => ipcRenderer.send('cmd', c, v),
  stop: () => ipcRenderer.send('stop'),
  menu: () => ipcRenderer.send('menu'),
  close: () => ipcRenderer.send('close'),
  fit: (w, h) => ipcRenderer.send('fit', w, h),
  setCompact: on => ipcRenderer.send('compact', on),
  onCompact: fn => ipcRenderer.on('compact', (_e, on) => fn(on)),
  onTips: fn => ipcRenderer.on('tips', (_e, on) => fn(on)),
  onSync: fn => ipcRenderer.on('sync', (_e, n) => fn(n)),
  onUpdate: fn => ipcRenderer.on('update', (_e, v) => fn(v)),
  onUpdating: fn => ipcRenderer.on('updating', (_e, v) => fn(v)),
  onNotice: fn => ipcRenderer.on('notice', (_e, v) => fn(v)),
  installUpdate: () => ipcRenderer.send('install-update'),
});
