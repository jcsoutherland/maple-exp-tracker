// MS Classic Tracker Overlay: a borderless, always-on-top window showing the tracker's numbers over the game.
// Linked: the website (in any browser) sends its numbers to this app on 127.0.0.1. Standalone: the app opens the
// tracker in its own window, which captures the game itself and sends its numbers the same way.
const { app, BrowserWindow, Menu, desktopCapturer, dialog, ipcMain, screen, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { autoUpdater } = require('electron-updater');

/** must match DESKTOP_PORT in the website (src/app/desktopLink.ts) */
const PORT = 47821;
/** the website opens the app with a mapleoverlay:// link (see launch() in src/app/desktopLink.ts) */
const PROTOCOL = 'mapleoverlay';
// development: MAPLE_SITE=http://localhost:5173/ runs the in-app tracker from a local dev server
const SITE = process.env.MAPLE_SITE || 'https://mapleclassic.training/';

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
    // a running session first; with none anywhere, this app's own tracker (what ▶ starts); then the one already shown
    // (no flicker), then the newest
    const rank = s.stats?.state === 'on' ? 3 : s.stats?.state === 'paused' ? 2 : s.inApp ? 1 : 0;
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
  overlay.webContents.on('did-finish-load', () => {
    if (updatingTo) overlay.webContents.send('updating', updatingTo);
    if (updateReady) overlay.webContents.send('update', updateReady);
  });
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
      if (m.type === 'stats') { sources.set(ws, { stats: m.stats, inApp: !!m.inApp, at: Date.now() }); pickSource(); }
      else if (m.type === 'show') showOverlay();
      else if (m.type === 'notice' && ws === shown) overlay?.webContents.send('notice', String(m.text || '').slice(0, 140));
    });
    ws.on('close', () => { sources.delete(ws); pickSource(); });
  });
}

/** Standalone: the tracker in its own window, capturing the game window the user picks. */
function openTracker(show = true) {
  if (tracker && !tracker.isDestroyed()) { if (show) { tracker.show(); tracker.focus(); } return; }
  // it keeps reading the game while hidden or minimised (no background throttling)
  tracker = new BrowserWindow({ width: 1280, height: 860, title: 'MS Classic Training Tracker', backgroundColor: '#0f0e1c', autoHideMenuBar: true, icon: ICON,
    show, webPreferences: { backgroundThrottling: false } });
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
    if (process.env.OVERLAY_TEST_PICK && list.length) { callback({ video: list[0] }); return; } // development: no dialog
    const r = await dialog.showMessageBox(tracker?.isVisible() ? tracker : overlay ?? undefined, {
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
    ...(updateReady ? [{ label: `Restart to update to ${updateReady}`, click: installUpdate }] : []),
    { label: `Version ${app.getVersion()}`, enabled: false },
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
ipcMain.on('install-update', installUpdate);
/**
 * The overlay's ▶ / ⏸ go to the tracker it shows. To the tracker inside this app they go as a real click (the
 * userGesture flag), so ▶ can open the window picker before starting; a browser tab gets a message instead.
 */
ipcMain.on('cmd', (_e, cmd) => sendCmd(cmd));
/** ■ ends the session (saved to History) and stops sharing, after asking. */
ipcMain.on('stop', async () => {
  const r = await dialog.showMessageBox(overlay ?? undefined, {
    type: 'question', title: 'End the session?', buttons: ['End session', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
    message: 'End the session and stop sharing the game window?', detail: 'The session is saved to History.',
  });
  if (r.response === 0) sendCmd('stop');
});
const hasSession = s => s?.stats?.state === 'on' || s?.stats?.state === 'paused';
/**
 * ▶ with no session anywhere tracks right here, no browser needed: this app's own tracker (opened hidden if it isn't
 * open) gets a real click, so it shows the window picker, then starts once the game window is shared.
 */
async function startHere(cmd = 'start') {
  openTracker(false);
  const inAppSource = () => [...sources].find(([, s]) => s.inApp)?.[0];
  for (const t0 = Date.now(); !inAppSource() && Date.now() - t0 < 30_000; ) await new Promise(r => setTimeout(r, 300));
  if (!tracker || tracker.isDestroyed()) return;
  tracker.webContents.executeJavaScript(`window.__overlayCmd && window.__overlayCmd(${JSON.stringify(cmd)})`, true).catch(() => undefined);
}
const webSource = () => [...sources].find(([, s]) => !s.inApp);
const appSource = () => [...sources].find(([, s]) => s.inApp);
/**
 * ▶ with the game shared nowhere yet asks how to share it: through Windows (this app tracks it: its picker, then the
 * session starts), or through the browser (the website tab tracks it; Chrome's picker only opens from a click in that
 * tab, so the tab highlights Share game window and starts once it's clicked, or the website opens when no tab is
 * connected).
 */
function shareChoice() {
  const web = webSource();
  Menu.buildFromTemplate([
    { label: 'Share with Windows (track in this app)', click: () => void startHere('start') },
    { label: web ? 'Share in the browser (the website tab)' : 'Share in the browser (opens the website)', click: shareInBrowser },
  ]).popup({ window: overlay });
}
function shareInBrowser() {
  const web = webSource();
  if (web) {
    web[0].send(JSON.stringify({ type: 'cmd', cmd: 'start' }));
    overlay?.webContents.send('notice', 'Click "Share game window" in your browser tab (it is highlighted there)');
  } else {
    shell.openExternal(SITE);
    overlay?.webContents.send('notice', 'Opened the website: switch on "Send stats to the desktop overlay" (Setup), then Share game window');
  }
}
/**
 * ▶ / ⏸ / ■ go to the tracker the overlay shows. ▶ with no session anywhere starts where the game is already shared, or
 * asks how to share it; ▶ on a paused session resumes it there (that tracker shares first only if it isn't sharing).
 */
function sendCmd(cmd) {
  if (!['start', 'pause', 'stop'].includes(cmd)) return;
  if (cmd === 'start' && !hasSession(sources.get(shown))) {
    const web = webSource(), own = appSource();
    if (own?.[1].stats?.sharing) { void startHere('start'); return; }
    if (web?.[1].stats?.sharing) { web[0].send(JSON.stringify({ type: 'cmd', cmd: 'start' })); return; }
    shareChoice(); return;
  }
  if (!shown) return;
  if (sources.get(shown)?.inApp && tracker && !tracker.isDestroyed()) {
    tracker.webContents.executeJavaScript(`window.__overlayCmd && window.__overlayCmd(${JSON.stringify(cmd)})`, true).catch(() => undefined);
    return;
  }
  shown.send(JSON.stringify({ type: 'cmd', cmd }));
}
ipcMain.on('open-tracker', openTracker);

/**
 * Updates itself from the GitHub releases, only when it's opened (started, or opened again from the website): a newer
 * version is downloaded and installed straight away, and the app reopens updated. If that takes longer than
 * UPDATE_NOW_MS, the overlay carries on as it is and the update installs when the app is closed (or from its Update
 * button), so it never cuts into a session.
 */
const UPDATE_NOW_MS = 20_000;
let updateReady = null, updatingTo = null, openedAt = 0;
const updating = v => { updatingTo = v; overlay?.webContents.send('updating', v); };
function startUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', info => { if (Date.now() - openedAt < UPDATE_NOW_MS) updating(info.version); });
  autoUpdater.on('update-not-available', () => updating(null));
  autoUpdater.on('update-downloaded', info => {
    updateReady = info.version;
    if (Date.now() - openedAt < UPDATE_NOW_MS) { installUpdate(); return; }
    updating(null);
    overlay?.webContents.send('update', updateReady);
  });
  autoUpdater.on('error', () => updating(null)); // offline or GitHub busy: next time
  checkUpdate();
}
/** Look for a newer version now (on opening). */
function checkUpdate() {
  if (!app.isPackaged || updateReady) return;
  openedAt = Date.now();
  autoUpdater.checkForUpdates().catch(() => undefined);
}
function installUpdate() { if (updateReady) autoUpdater.quitAndInstall(true, true); }

/** Bring the overlay to the front (opened again from the website, or a second launch). */
function showOverlay() {
  if (!overlay) return;
  if (overlay.isMinimized()) overlay.restore();
  overlay.show(); overlay.focus(); overlay.moveTop();
}

/**
 * Let the website open this app with a mapleoverlay:// link. The installer registers it too; doing it on every start
 * keeps it pointing at this copy (and covers a portable build, which runs from a temporary copy of itself).
 */
function registerProtocol() {
  if (!app.isPackaged) return;
  app.setAsDefaultProtocolClient(PROTOCOL, process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, []);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { showOverlay(); checkUpdate(); });
  app.whenReady().then(() => {
    registerProtocol(); startLink(); handleCapture(); createOverlay(); startUpdates();
    // development: OVERLAY_TEST_START=<ms> presses the overlay's ▶ (with OVERLAY_TEST_CMD=windows, picks "Share with Windows")
    if (process.env.OVERLAY_TEST_START) setTimeout(() => (process.env.OVERLAY_TEST_CMD === 'windows' ? startHere('start') : sendCmd('start')), +process.env.OVERLAY_TEST_START);
    // development: OVERLAY_TEST_STOP=<ms> presses ■ (without its confirmation) that long after start
    if (process.env.OVERLAY_TEST_STOP) setTimeout(() => sendCmd('stop'), +process.env.OVERLAY_TEST_STOP);
  });
  app.on('window-all-closed', () => app.quit());
}
