/**
 * The link to the desktop overlay app (desktop/ in this repo): a borderless, always-on-top window with no browser
 * address strip. The app listens on this computer only (127.0.0.1); the tracker sends it the overlay's numbers once a
 * second and takes its Start / Pause buttons back. Only when switched on (Setup tab) or inside the app itself, so
 * nobody else's browser ever reaches for a local port.
 */

/** must match PORT in desktop/main.js */
export const DESKTOP_PORT = 47821;
/** the app's download: the latest GitHub release */
export const DESKTOP_DOWNLOAD = 'https://github.com/jcsoutherland/maple-exp-tracker/releases/latest/download/MapleTrackerOverlay-Setup.exe';
/** this page is the tracker running inside the desktop app (standalone mode) */
export const inDesktopApp = () => new URLSearchParams(location.search).has('desktop');

export type LinkState = 'off' | 'connecting' | 'connected';
/**
 * How long a launched app gets to connect before it's taken as not installed: briefly when nothing happened at all (an
 * unknown link opens nothing, silently), much longer once the page lost focus, since then Chrome asked "Open app?" or the
 * app itself came up, and an app that's starting (or a user reading the question) mustn't be taken for a missing one.
 */
const LAUNCH_QUIET_MS = 5000, LAUNCH_BUSY_MS = 30_000;

const SEEN_KEY = 'desktopOverlaySeen';
/** Has the desktop app ever connected from this browser? (A page can't see what's installed; this is the next best.) */
export const appSeen = () => { try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; } };

/** Start the app's download (the latest release). */
export function downloadApp() {
  const a = document.createElement('a');
  a.href = DESKTOP_DOWNLOAD; a.rel = 'noopener';
  document.body.append(a); a.click(); a.remove();
}

export class DesktopLink {
  private ws: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  state: LinkState = 'off';
  constructor(private onCmd: (cmd: 'start' | 'pause') => void, private onState: () => void) {}

  /** Connect (and keep reconnecting every 5 s while the app isn't running), or disconnect. */
  enable(on: boolean) {
    if (on === this.wanted) return;
    this.wanted = on;
    if (on) this.connect();
    else { if (this.retry) clearTimeout(this.retry); this.retry = null; this.ws?.close(); this.ws = null; this.set('off'); }
  }
  /**
   * Open the app: already connected, bring it to the front; otherwise open it through its mapleoverlay:// link (Chrome
   * asks first) and wait for it to connect. A page can't see what's installed, so a link that opens nothing looks just
   * like an app that isn't there: false after the wait means not installed (or an app older than 1.2.0, before the link).
   */
  async launch(): Promise<boolean> {
    if (this.state === 'connected') { this.ws?.send(JSON.stringify({ type: 'show' })); return true; }
    // with stats switched off, connect just long enough to see whether the app came up
    const probe = !this.wanted;
    if (probe) this.enable(true);
    const ok = await this.open();
    if (probe) this.enable(false);
    return ok;
  }
  private async open() {
    let blurred = !document.hasFocus();
    const onBlur = () => { blurred = true; };
    window.addEventListener('blur', onBlur);
    try {
      location.href = 'mapleoverlay://open';
      const start = Date.now();
      while (!this.isConnected()) {
        const waited = Date.now() - start;
        if (waited > (blurred || !document.hasFocus() ? LAUNCH_BUSY_MS : LAUNCH_QUIET_MS)) return false;
        if (!this.ws) { if (this.retry) clearTimeout(this.retry); this.retry = null; this.connect(); }
        await new Promise(r => setTimeout(r, 700));
      }
      return true;
    } finally { window.removeEventListener('blur', onBlur); }
  }
  send(stats: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'stats', stats, inApp: inDesktopApp() }));
  }
  /** A short message on the overlay (why ▶ couldn't start, say). */
  notice(text: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'notice', text }));
  }

  // a call, not a field read: the state changes while launch() waits
  private isConnected() { return this.state === 'connected'; }
  private set(s: LinkState) { if (s !== this.state) { this.state = s; this.onState(); } }
  private connect() {
    if (!this.wanted) return;
    this.set('connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(`ws://127.0.0.1:${DESKTOP_PORT}`); } catch { this.later(); return; }
    this.ws = ws;
    ws.onopen = () => { this.set('connected'); try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private window */ } };
    ws.onmessage = e => {
      try {
        const m = JSON.parse(String(e.data));
        if (m.type === 'cmd' && (m.cmd === 'start' || m.cmd === 'pause')) this.onCmd(m.cmd);
      } catch { /* not ours */ }
    };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.set(this.wanted ? 'connecting' : 'off'); this.later(); } };
    ws.onerror = () => ws.close();
  }
  private later() { if (this.wanted && !this.retry) this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 5000); }
}
