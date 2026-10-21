// The link between this app and the tracker pages: the website in a browser, and the app's own tracker (the website
// in a hidden window, which tracks when the game is shared through Windows). Both connect over a WebSocket on this
// computer only. The app relays between them: finished sessions from its tracker go to the website's History, the
// website's Setup goes to its tracker, and its tracker's session goes to the website to be shown live.
const { WebSocketServer } = require('ws');

/** must match DESKTOP_PORT in the website (src/app/desktopLink.ts) */
const PORT = 47821;
/** only the tracker's own pages (the site, or a local dev copy) may connect */
const ORIGINS = /^https:\/\/mapleclassic\.training$|^http:\/\/localhost(:\d+)?$/;

/**
 * hooks: onShown(stats | null) when the overlay's numbers change, onSaved() when a session arrives for the outbox,
 * onError(message) when the link can't start, notice(text) for a short message on the overlay.
 */
function createLink(store, hooks) {
  /** every tracker page connected: its latest numbers, whether it's the app's own tracker, and when they came */
  const sources = new Map();
  let shown = null;
  const send = (ws, msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
  const webs = () => [...sources].filter(([, s]) => s.web).map(([ws]) => ws);
  const appTracker = () => [...sources].find(([, s]) => s.inApp)?.[0] ?? null;
  const statsOf = ws => (ws ? sources.get(ws)?.stats ?? null : null);

  /**
   * The overlay shows one tracker, and its buttons go back to that one: a running session first, then a paused one,
   * then one sharing the game, then the app's own; then the one already shown (no flicker), then the newest. A website
   * showing the app's session live only repeats the app's numbers, so it never takes the overlay over.
   */
  function pickSource() {
    let best = null;
    for (const [ws, s] of sources) {
      if (!s.stats || s.stats.mirroring) continue;
      const rank = s.stats.state === 'on' ? 4 : s.stats.state === 'paused' ? 3 : s.stats.sharing ? 2 : s.inApp ? 1 : 0;
      if (!best || rank > best.rank || (rank === best.rank && (ws === shown || (best.ws !== shown && s.at > best.at)))) best = { ws, rank, at: s.at };
    }
    shown = best?.ws ?? null;
    hooks.onShown(statsOf(shown));
  }

  /** the app's tracker reads the game with the website's Setup, plus an auto-pause time set on the overlay meanwhile */
  function setupForApp() {
    const bundle = store.setup(), pending = store.state().pendingIdle;
    if (!bundle || !pending) return bundle;
    try {
      const settings = JSON.parse(bundle['met.settings'] || '{}');
      return { ...bundle, 'met.settings': JSON.stringify({ ...settings, idlePauseSec: pending.value }) };
    } catch (e) { store.log(`setup: unreadable settings (${e.message})`); return bundle; }
  }
  function sendSetupToApp() {
    const ws = appTracker(), bundle = setupForApp();
    if (ws && bundle) send(ws, { type: 'setup', bundle });
  }
  /** what a website gets when it links: sessions waiting for its History, and an auto-pause change to settle */
  function greetWeb(ws) {
    const list = store.outbox(), pending = store.state().pendingIdle;
    if (list.length) send(ws, { type: 'sessions', list });
    if (pending) send(ws, { type: 'pendingIdle', ...pending });
  }

  function receive(ws, m) {
    const src = sources.get(ws);
    if (m.type === 'stats') {
      const first = !src.stats;
      Object.assign(src, { stats: m.stats, inApp: !!m.inApp, at: Date.now() });
      if (first && src.inApp) { store.log('app tracker linked'); sendSetupToApp(); }
      pickSource();
    } else if (m.type === 'setup' && m.bundle && typeof m.bundle === 'object') {
      if (!src.web) { src.web = true; store.log('website linked'); greetWeb(ws); }
      store.saveSetup(m.bundle);
      sendSetupToApp();
    } else if (m.type === 'saved' && src.inApp && m.session?.id) {
      store.addToOutbox(m.session);
      store.log(`session ${m.session.id} saved (${Math.round((m.session.activeMs || 0) / 60000)} min)`);
      for (const w of webs()) send(w, { type: 'sessions', list: store.outbox() });
      hooks.onSaved(m.session);
    } else if (m.type === 'ack' && Array.isArray(m.ids)) {
      store.removeFromOutbox(m.ids);
      store.log(`website took ${m.ids.length} session(s) into History`);
      hooks.onSaved(null);
    } else if (m.type === 'mirror' && src.inApp) {
      for (const w of webs()) send(w, { type: 'mirror', snap: m.snap ?? null });
    } else if (m.type === 'cmd' && src.web && typeof m.cmd === 'string') {
      hooks.onWebCmd(m.cmd, m.value);
    } else if (m.type === 'idleResolved') {
      store.saveState({ pendingIdle: null });
      sendSetupToApp();
    } else if (m.type === 'diag' && typeof m.line === 'string') {
      store.log(`${src.inApp ? 'app tracker' : 'website'}: ${m.line.slice(0, 400)}`);
    } else if (m.type === 'show') hooks.show();
    else if (m.type === 'notice' && ws === shown) hooks.notice(String(m.text || '').slice(0, 140));
  }

  function start() {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
    wss.on('error', e => { store.log(`link failed: ${e.message}`); hooks.onError(e.code === 'EADDRINUSE' ? 'The overlay is already running.' : 'The overlay could not start its link: ' + e.message); });
    wss.on('connection', (ws, req) => {
      if (!ORIGINS.test(req.headers.origin || '')) { ws.close(); return; }
      sources.set(ws, { stats: null, inApp: false, web: false, at: Date.now() });
      ws.on('message', buf => {
        let m;
        try { m = JSON.parse(String(buf)); } catch { store.log('link: unreadable message'); return; }
        if (m && typeof m === 'object') receive(ws, m);
      });
      ws.on('close', () => {
        const s = sources.get(ws);
        sources.delete(ws);
        if (s?.inApp) { store.log('app tracker unlinked'); for (const w of webs()) send(w, { type: 'mirror', snap: null }); }
        else if (s?.web) store.log('website unlinked');
        pickSource();
      });
    });
  }

  return {
    start,
    /** the numbers the overlay shows, the app's tracker's, and a website's (null when not connected) */
    shownStats: () => statsOf(shown),
    appStats: () => statsOf(appTracker()),
    webStats: () => { const w = webs().find(ws => !sources.get(ws).stats?.mirroring) ?? webs()[0]; return w ? statsOf(w) : null; },
    hasWeb: () => webs().length > 0,
    hasAppTracker: () => !!appTracker(),
    shownIsApp: () => !!shown && !!sources.get(shown)?.inApp,
    /** a command for the shown tracker, or for the first website (the app's tracker takes its commands as clicks) */
    toShown: (cmd, value) => { if (shown) send(shown, { type: 'cmd', cmd, value }); },
    toWeb: (cmd, value) => { const w = webs()[0]; if (w) send(w, { type: 'cmd', cmd, value }); return !!w; },
    /** an auto-pause time set on the overlay while the app tracks: the website takes it now, or when it next links */
    idleChanged(value) {
      const pending = { value, at: Date.now() };
      store.saveState({ pendingIdle: pending });
      for (const w of webs()) send(w, { type: 'pendingIdle', ...pending });
    },
  };
}

module.exports = { createLink, PORT };
