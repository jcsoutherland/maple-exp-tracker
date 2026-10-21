// MS Classic Tracker Overlay: a borderless, always-on-top window showing the tracker's numbers over the game, and the
// remote for it. The game is shared through Windows (this app's own tracker, a hidden copy of the website, reads it) or
// through the browser (the website tab reads it); either way the website is where the full stats and History live.
const { app, BrowserWindow, Menu, dialog, ipcMain, screen, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { createStore } = require('./store');
const { createLink } = require('./link');
const { findGame, gameProcessRunning } = require('./game');

/** the website opens the app with a mapleoverlay:// link (see launch() in src/app/desktopLink.ts) */
const PROTOCOL = 'mapleoverlay';
// run from the project (npm run overlay), it's a preview of the next version: its tracker loads the local dev server
// (npm run dev), or MAPLE_SITE
const SITE = process.env.MAPLE_SITE || (app.isPackaged ? 'https://mapleclassic.training/' : 'http://localhost:5173/');
/** the overlay's width; its height follows what it shows (shorter with the tips off) */
const WIDTH = 418;

const ICON = path.join(__dirname, 'build', 'icon.png');
let overlay = null, tracker = null, store = null, link = null;

function createOverlay() {
  const st = store.state(), area = screen.getPrimaryDisplay().workArea;
  overlay = new BrowserWindow({
    width: WIDTH, height: 128, x: st.x ?? area.x + area.width - WIDTH - 20, y: st.y ?? area.y + 20,
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: false, useContentSize: true,
    backgroundColor: '#13112a', title: 'EXP Tracker', fullscreenable: false, maximizable: false,
    icon: ICON, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // above a borderless-fullscreen game too
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true);
  overlay.loadFile(path.join(__dirname, 'overlay.html'));
  overlay.webContents.on('did-finish-load', () => {
    const s = store.state();
    overlay.webContents.send('tips', s.tips !== false);
    overlay.webContents.send('compact', !!s.compact);
    overlay.webContents.send('sync', store.outbox().length);
    overlay.webContents.send('stats', link.shownStats() ?? s.lastStats ?? null);
    if (updatingTo) overlay.webContents.send('updating', updatingTo);
    if (updateReady) overlay.webContents.send('update', updateReady);
  });
  overlay.on('moved', () => { if (overlay && !overlay.isDestroyed()) { const b = overlay.getBounds(); store.saveState({ x: b.x, y: b.y }); } });
  overlay.on('closed', () => { overlay = null; app.quit(); });
  // development: OVERLAY_SHOT=<file.png> saves what the overlay shows after a few seconds
  if (process.env.OVERLAY_SHOT) setTimeout(() => overlay?.webContents.capturePage().then(i => fs.writeFileSync(process.env.OVERLAY_SHOT, i.toPNG())), +(process.env.OVERLAY_SHOT_MS || 8000));
}

/** The overlay's numbers; once no tracker is linked, the last ones stay up (a finished session, kept for review). */
let wasLast = false;
function showStats(stats) {
  if (stats) {
    // remember a finished session's numbers, so they're still there when the app is opened again
    if (stats.last && !wasLast) store.saveState({ lastStats: stats });
    wasLast = !!stats.last;
  }
  overlay?.webContents.send('stats', stats ?? store.state().lastStats ?? null);
}

/** The app's tracker: the website in a hidden window, which reads the game when it's shared through Windows. */
function openTracker() {
  if (tracker && !tracker.isDestroyed()) return;
  // it keeps reading the game while hidden (no background throttling)
  tracker = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  tracker.loadURL(SITE + '?desktop=1');
  tracker.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  tracker.webContents.on('render-process-gone', (_e, d) => store.log(`app tracker stopped: ${d.reason}`));
  tracker.on('closed', () => { tracker = null; });
}
/** A button for the app's tracker, as a real click (so it may open the window picker), once it has linked. */
async function toAppTracker(cmd, value) {
  openTracker();
  for (const t0 = Date.now(); !link.hasAppTracker() && Date.now() - t0 < 30_000; ) await new Promise(r => setTimeout(r, 300));
  if (!tracker || tracker.isDestroyed()) return;
  store.log(`app tracker: ${cmd}`);
  tracker.webContents.executeJavaScript(`window.__overlayCmd && window.__overlayCmd(${JSON.stringify(cmd)}, ${JSON.stringify(value ?? null)})`, true)
    .catch(e => store.log(`app tracker command failed: ${e.message}`));
}

/** The game window couldn't be found: minimized, or not running. */
async function gameNotFound() {
  const minimized = await gameProcessRunning().catch(e => { store.log(`tasklist failed: ${e.message}`); return false; });
  store.log(minimized ? 'MapleStory is minimized' : 'MapleStory is not running');
  dialog.showMessageBox(overlay ?? undefined, minimized
    ? { type: 'warning', title: 'MapleStory is minimized', message: 'MapleStory is minimized', detail: 'Bring the game window back up, then press Start session again.', buttons: ['OK'], noLink: true }
    : { type: 'warning', title: 'MapleStory isn\'t running', message: 'MapleStory isn\'t running', detail: 'Start the game, then press Start session again.', buttons: ['OK'], noLink: true });
}
/** Sharing through Windows hands the app's tracker the MapleStory window, with no picker. */
function handleCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const game = await findGame();
    if (game) { callback({ video: game }); return; }
    callback({});
    void gameNotFound();
  });
}

const sharing = s => !!s?.sharing;
const hasSession = s => s?.state === 'on' || s?.state === 'paused';
/** Share the game through Windows: needs the website's Setup (synced once) and the game running. */
async function shareWindows(thenStart) {
  store.log(`share with Windows${thenStart ? ' and start' : ''}`);
  if (!store.setup()) {
    store.log('no Setup from the website yet');
    const r = await dialog.showMessageBox(overlay ?? undefined, {
      type: 'info', title: 'Set up on the website first', message: 'Set up on the website first', buttons: ['Open website', 'Close'], defaultId: 0, cancelId: 1, noLink: true,
      detail: 'Your game boxes and potions come from the website. Open it once while this app is running and they\'ll sync.',
    });
    if (r.response === 0) shell.openExternal(SITE);
    return;
  }
  if (!(await findGame())) { void gameNotFound(); return; }
  void toAppTracker(thenStart ? 'start' : 'share');
}
/** Share the game through the browser: the website tab asks (its picker opens only from a click there), or opens. */
function shareBrowser(thenStart) {
  if (link.toWeb(thenStart ? 'start' : 'share')) { overlay?.webContents.send('notice', 'Click "Share game window" in your browser tab (it is highlighted there)'); return; }
  shell.openExternal(`${SITE}?overlay=${thenStart ? 'start' : 'share'}`);
  overlay?.webContents.send('notice', 'Opened the website: click "Share game window" there');
}
function shareChoice(thenStart) {
  Menu.buildFromTemplate([
    { label: 'With Windows', click: () => void shareWindows(thenStart) },
    { label: 'In the browser', click: () => shareBrowser(thenStart) },
  ]).popup({ window: overlay });
}
/** Stop sharing, wherever the game is shared: a running session is ended and saved first. */
function stopSharing() {
  if (sharing(link.appStats())) void toAppTracker('stopShare');
  else link.toWeb('stopShare');
}

/**
 * The overlay's buttons and the website's (while the app tracks): ▶ starts a session (sharing first when nothing is
 * shared, then starting by itself) or resumes, ⏸ pauses, ■ ends and saves, stopShare stops sharing, idle sets the
 * auto-pause time. They go to the tracker that's sharing or running.
 */
function sendCmd(cmd, value) {
  if (!['start', 'pause', 'stop', 'stopShare', 'idle'].includes(cmd)) return;
  store.log(`button: ${cmd}${value != null ? ' ' + value : ''}`);
  if (cmd === 'stopShare') { stopSharing(); return; }
  const own = link.appStats(), web = link.webStats();
  const toApp = hasSession(own) || (!hasSession(link.shownStats()) && sharing(own)) || (cmd !== 'start' && link.shownIsApp());
  if (cmd === 'start' && !hasSession(link.shownStats()) && !sharing(own) && !sharing(web)) { shareChoice(true); return; }
  if (toApp) {
    if (cmd === 'idle') link.idleChanged(value);
    void toAppTracker(cmd, value);
    return;
  }
  if (cmd === 'start' && !hasSession(link.shownStats()) && sharing(web)) { link.toWeb('start'); return; }
  link.toShown(cmd, value);
}

const IDLE_CHOICES = [[0, 'Off'], [30, '30 seconds'], [45, '45 seconds'], [60, '1 minute'], [120, '2 minutes'], [300, '5 minutes']];
function menu() {
  const st = link.shownStats(), idle = st?.idleSec, waiting = store.outbox().length;
  const shared = sharing(link.appStats()) || sharing(link.webStats());
  const tipsOn = store.state().tips !== false;
  return Menu.buildFromTemplate([
    { label: 'Open full stats', click: () => shell.openExternal(SITE) },
    ...(waiting ? [{ label: `Sync stats (${waiting})`, sublabel: 'Opens the website, which takes them into History', click: () => shell.openExternal(SITE) }] : []),
    { type: 'separator' },
    shared
      ? { label: 'Stop sharing', sublabel: 'A running session is saved first', click: stopSharing }
      : { label: 'Share game window', submenu: [{ label: 'With Windows', click: () => void shareWindows(false) }, { label: 'In the browser', click: () => shareBrowser(false) }] },
    { type: 'separator' },
    {
      label: 'Auto-pause when idle', enabled: !!st && st.idleOk !== false,
      sublabel: st && st.idleOk === false ? 'Off: no EXP or loot is being read' : undefined,
      submenu: IDLE_CHOICES.map(([v, label]) => ({ label, type: 'radio', checked: idle === v, click: () => sendCmd('idle', v) }))
        .concat(idle != null && !IDLE_CHOICES.some(([v]) => v === idle) ? [{ label: `${idle} seconds (set on the website)`, type: 'radio', checked: true, enabled: false }] : []),
    },
    { label: 'Always on top', type: 'checkbox', checked: overlay?.isAlwaysOnTop() ?? true, click: i => overlay?.setAlwaysOnTop(i.checked, 'screen-saver') },
    { label: 'Show tips', type: 'checkbox', checked: tipsOn, click: i => { store.saveState({ tips: i.checked }); overlay?.webContents.send('tips', i.checked); } },
    { label: 'Reset size and position', click: () => { const a = screen.getPrimaryDisplay().workArea; overlay?.setPosition(a.x + a.width - WIDTH - 20, a.y + 20); store.saveState({ x: undefined, y: undefined }); } },
    { type: 'separator' },
    ...(updateReady ? [{ label: `Restart to update to ${updateReady}`, click: installUpdate }] : []),
    { label: `Version ${app.getVersion()}${app.isPackaged ? '' : ' (preview)'}`, enabled: false },
    { label: 'Close the overlay', click: confirmClose },
  ]);
}

/**
 * Close the app. When it's sharing the game or tracking, it asks first, then ends and saves the session (it goes to
 * the website's History) and stops sharing. Tracking on the website keeps going.
 */
async function confirmClose() {
  const own = link.appStats();
  if (!sharing(own) && !hasSession(own)) { app.quit(); return; }
  const r = await dialog.showMessageBox(overlay ?? undefined, {
    type: 'question', title: 'Close the overlay?', message: 'Close the overlay?', buttons: ['Save and close', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
    detail: hasSession(own) ? 'Your session will be saved and sharing will stop.' : 'Sharing will stop.',
  });
  if (r.response !== 0) return;
  if (hasSession(own)) {
    savedWaiters.length = 0;
    const saved = new Promise(res => savedWaiters.push(res));
    void toAppTracker('stop');
    await Promise.race([saved, new Promise(res => setTimeout(res, 5000))]);
  }
  app.quit();
}
/** waiting for the app's tracker to hand over a session (closing) */
const savedWaiters = [];

ipcMain.on('menu', () => menu().popup({ window: overlay }));
ipcMain.on('close', confirmClose);
ipcMain.on('install-update', installUpdate);
ipcMain.on('cmd', (_e, cmd, value) => sendCmd(cmd, value));
/** the overlay's size, as laid out: full width (tips on or off), or just the compact row */
ipcMain.on('fit', (_e, w, h) => {
  if (!overlay || !Number.isFinite(h) || h < 20 || h > 400) return;
  const width = Number.isFinite(w) && w > 60 && w < WIDTH ? Math.ceil(w) : WIDTH;
  overlay.setContentSize(width, Math.ceil(h));
});
/** super compact on or off: remembered for next time */
ipcMain.on('compact', (_e, on) => store.saveState({ compact: !!on }));
/** ■ ends the session (saved to History), after asking. */
ipcMain.on('stop', async () => {
  const r = await dialog.showMessageBox(overlay ?? undefined, {
    type: 'question', title: 'End the session?', buttons: ['End session', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
    message: 'End the session?', detail: 'It is saved to History. The game window stays shared, ready for the next session.',
  });
  if (r.response === 0) sendCmd('stop');
});

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
  autoUpdater.on('update-available', info => { if (Date.now() - openedAt < UPDATE_NOW_MS) updating({ version: info.version, percent: 0 }); });
  autoUpdater.on('download-progress', p => { if (updatingTo) updating({ ...updatingTo, percent: p.percent }); });
  autoUpdater.on('update-not-available', () => updating(null));
  autoUpdater.on('update-downloaded', info => {
    updateReady = info.version;
    if (Date.now() - openedAt < UPDATE_NOW_MS) { installUpdate(); return; }
    updating(null);
    overlay?.webContents.send('update', updateReady);
  });
  autoUpdater.on('error', e => { store.log(`update failed: ${e.message}`); updating(null); }); // offline or GitHub busy: next time
  checkUpdate();
}
/** Look for a newer version now (on opening). */
function checkUpdate() {
  if (!app.isPackaged || updateReady) return;
  openedAt = Date.now();
  autoUpdater.checkForUpdates().catch(e => store.log(`update check failed: ${e.message}`));
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
 * keeps it pointing at this copy.
 */
function registerProtocol() {
  if (!app.isPackaged) return;
  app.setAsDefaultProtocolClient(PROTOCOL, process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, []);
}

// a preview keeps its files apart from the installed app's (or in OVERLAY_USER_DATA=<folder>)
if (process.env.OVERLAY_USER_DATA) app.setPath('userData', process.env.OVERLAY_USER_DATA);
else if (!app.isPackaged) app.setPath('userData', app.getPath('userData') + ' (preview)');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { showOverlay(); checkUpdate(); });
  app.whenReady().then(() => {
    store = createStore(app.getPath('userData'));
    store.log(`started ${app.getVersion()}`);
    link = createLink(store, {
      onShown: showStats,
      onSaved: s => { overlay?.webContents.send('sync', store.outbox().length); if (s) savedWaiters.splice(0).forEach(res => res()); },
      onWebCmd: sendCmd,
      onError: text => { dialog.showErrorBox('Overlay', text); app.quit(); },
      show: showOverlay,
      notice: text => overlay?.webContents.send('notice', text),
    });
    registerProtocol(); link.start(); handleCapture(); createOverlay(); startUpdates();
    // development: OVERLAY_TEST_CMD=<cmd> with OVERLAY_TEST_START=<ms> presses a button that long after start
    // (windows: Start session, sharing with Windows; browser: the same through the browser)
    if (process.env.OVERLAY_TEST_START) setTimeout(() => {
      const c = process.env.OVERLAY_TEST_CMD || 'start';
      if (c === 'windows') void shareWindows(true); else if (c === 'browser') shareBrowser(true); else sendCmd(c);
    }, +process.env.OVERLAY_TEST_START);
    // development: OVERLAY_TEST_STOP=<ms> presses ■ (without its confirmation) that long after start
    if (process.env.OVERLAY_TEST_STOP) setTimeout(() => sendCmd('stop'), +process.env.OVERLAY_TEST_STOP);
  });
  app.on('window-all-closed', () => app.quit());
}
