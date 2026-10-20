// MS Classic Tracker Overlay: a borderless, always-on-top window showing the tracker's numbers over the game.
// Linked: the website (in any browser) sends its numbers to this app on 127.0.0.1. Standalone: the app opens the
// tracker in its own window, which captures the game itself and sends its numbers the same way.
const { app, BrowserWindow, Menu, desktopCapturer, dialog, ipcMain, screen, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

/** must match DESKTOP_PORT in the website (src/app/desktopLink.ts) */
const PORT = 47821;
const SITE = 'https://mapleclassic.training/';

const statePath = () => path.join(app.getPath('userData'), 'overlay.json');
const loadState = () => { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; } };
const saveState = p => { try { fs.writeFileSync(statePath(), JSON.stringify({ ...loadState(), ...p })); } catch { /* not saved */ } };

const ICON = path.join(__dirname, 'build', 'icon.png');
let overlay = null, tracker = null, wss = null;
/**
 * Every tracker page connected (the website in a browser, the tracker inside this app): its latest numbers and when
 * they came. The overlay shows one source, the one with a session running, and its buttons go back to that one: a
 * second tracker sitting idle (the app's own, opened while the website tracks) never takes the overlay over.
 */
const sources = new Map();
let shown = null;
function pickSource() {
  let best = null;
  for (const [ws, s] of sources) {
    const rank = s.stats?.state === 'on' ? 2 : s.stats?.state === 'paused' ? 1 : 0;
    // a running session first; among equals, the one already shown (no flicker), then the newest
    if (!best || rank > best.rank || (rank === best.rank && (ws === shown || (best.ws !== shown && s.at > best.at)))) best = { ws, rank, at: s.at };
  }
  shown = best?.ws ?? null;
  overlay?.webContents.send('stats', shown ? sources.get(shown).stats : null);
}

function createOverlay() {
  const st = loadState(), area = screen.getPrimaryDisplay().workArea;
  overlay = new BrowserWindow({
    width: st.w || 380, height: st.h || 126, x: st.x ?? area.x + area.width - 400, y: st.y ?? area.y + 20,
    frame: false, resizable: true, minWidth: 260, minHeight: 90, alwaysOnTop: true, skipTaskbar: false,
    backgroundColor: '#13112a', title: 'EXP Tracker', fullscreenable: false, maximizable: false,
    icon: ICON, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // above a borderless-fullscreen game too
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true);
  overlay.loadFile(path.join(__dirname, 'overlay.html'));
  const remember = () => { if (overlay && !overlay.isDestroyed()) { const b = overlay.getBounds(); saveState({ x: b.x, y: b.y, w: b.width, h: b.height }); } };
  overlay.on('moved', remember); overlay.on('resized', remember);
  overlay.on('closed', () => { overlay = null; app.quit(); });
  // development: OVERLAY_SHOT=<file.png> saves what the overlay shows after a few seconds
  if (process.env.OVERLAY_SHOT) setTimeout(() => overlay?.webContents.capturePage().then(i => fs.writeFileSync(process.env.OVERLAY_SHOT, i.toPNG())), +(process.env.OVERLAY_SHOT_MS || 8000));
}

/** The website talks to the app over a WebSocket on this computer only. */
function startLink() {
  wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
  wss.on('error', e => {
    dialog.showErrorBox('Overlay', e.code === 'EADDRINUSE' ? 'The overlay is already running.' : 'The overlay could not start its link: ' + e.message);
    app.quit();
  });
  wss.on('connection', (ws, req) => {
    // only the tracker's own pages (the site, or a local dev copy) may drive the overlay
    const origin = req.headers.origin || '';
    if (!/^https:\/\/mapleclassic\.training$|^http:\/\/localhost(:\d+)?$/.test(origin)) { ws.close(); return; }
    ws.on('message', buf => {
      let m; try { m = JSON.parse(String(buf)); } catch { return; }
      if (m.type === 'stats') { sources.set(ws, { stats: m.stats, at: Date.now() }); pickSource(); }
    });
    ws.on('close', () => { sources.delete(ws); pickSource(); });
  });
}

/** Standalone: the tracker in its own window, capturing the game window the user picks. */
function openTracker() {
  if (tracker && !tracker.isDestroyed()) { tracker.show(); tracker.focus(); return; }
  tracker = new BrowserWindow({ width: 1280, height: 860, title: 'MS Classic Training Tracker', backgroundColor: '#0f0e1c', autoHideMenuBar: true, icon: ICON });
  tracker.loadURL(SITE + '?desktop=1');
  tracker.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  tracker.on('closed', () => { tracker = null; });
}

/** "Share game window" inside the app: list the open windows and let the user pick (MapleStory first). */
function handleCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } });
    const windows = sources.filter(s => s.name && !/MS Classic Tracker Overlay|EXP Tracker|MS Classic Training Tracker/.test(s.name));
    windows.sort((a, b) => (/maple/i.test(b.name) ? 1 : 0) - (/maple/i.test(a.name) ? 1 : 0));
    const list = windows.slice(0, 8);
    const r = await dialog.showMessageBox(tracker ?? undefined, {
      type: 'question', title: 'Share a window', message: 'Which window should the tracker read?',
      buttons: [...list.map(s => s.name.slice(0, 60)), 'Cancel'], cancelId: list.length, defaultId: 0, noLink: true,
    });
    if (r.response >= list.length) { callback({}); return; }
    callback({ video: list[r.response] });
  });
}

function menu() {
  return Menu.buildFromTemplate([
    { label: 'Open the tracker here (no browser needed)', click: openTracker },
    { label: 'Open the website in my browser', click: () => shell.openExternal(SITE) },
    { type: 'separator' },
    { label: 'Always on top', type: 'checkbox', checked: overlay?.isAlwaysOnTop() ?? true, click: i => overlay?.setAlwaysOnTop(i.checked, 'screen-saver') },
    { label: 'Reset size and position', click: () => { const a = screen.getPrimaryDisplay().workArea; overlay?.setBounds({ x: a.x + a.width - 400, y: a.y + 20, width: 380, height: 126 }); } },
    { type: 'separator' },
    { label: 'Close the overlay', click: confirmClose },
  ]);
}

/** Close the app, after asking: it ends the overlay, and the tracker inside the app with any session it's running. */
async function confirmClose() {
  const own = tracker && !tracker.isDestroyed();
  const r = await dialog.showMessageBox(overlay ?? undefined, {
    type: 'warning', title: 'Close the overlay?', buttons: ['Close', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    message: 'You are about to close the overlay.',
    detail: own
      ? 'The tracker open in this app closes too. If it is tracking, end the session there first so it is saved to History.'
      : 'Tracking on the website keeps going; open the app again to bring the overlay back.',
  });
  if (r.response === 0) app.quit();
}

ipcMain.on('menu', () => menu().popup({ window: overlay }));
ipcMain.on('close', confirmClose);
ipcMain.on('cmd', (_e, cmd) => { if (shown && ['start', 'pause'].includes(cmd)) shown.send(JSON.stringify({ type: 'cmd', cmd })); });
ipcMain.on('open-tracker', openTracker);

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => overlay?.show());
  app.whenReady().then(() => { startLink(); handleCapture(); createOverlay(); });
  app.on('window-all-closed', () => app.quit());
}
