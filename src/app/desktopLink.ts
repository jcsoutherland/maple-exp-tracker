import type { SavedSession } from '../core/session';
import type { PendingIdle, SetupBundle } from './desktopSync';
import type { MirrorSnapshot } from './mirror';

/**
 * The link to the desktop overlay app (desktop/ in this repo): a borderless, always-on-top window with no browser
 * address strip. The app listens on this computer only (127.0.0.1). The tracker sends it the overlay's numbers once a
 * second and takes its buttons back; the website also sends its Setup and takes in the sessions the app tracked, and
 * shows the app's session live while the app tracks. Only once the app has connected from this browser (or inside the
 * app itself), so nobody else's browser ever reaches for a local port.
 */

/** must match PORT in desktop/main.js */
export const DESKTOP_PORT = 47821;
/** the app's download: the latest GitHub release */
export const DESKTOP_DOWNLOAD = 'https://github.com/jcsoutherland/maple-exp-tracker/releases/latest/download/MapleTrackerOverlay-Setup.exe';
/** this page is the tracker running inside the desktop app (it tracks when the game is shared through Windows) */
export const inDesktopApp = () => new URLSearchParams(location.search).has('desktop');

export type LinkState = 'off' | 'connecting' | 'connected';
/** what the desktop overlay's buttons (and the website's, while the app tracks) ask of a tracker */
export const OVERLAY_CMDS = ['share', 'start', 'pause', 'stop', 'stopShare', 'idle'] as const;
export type OverlayCmd = (typeof OVERLAY_CMDS)[number];

/** what the app sends a tracker page besides commands */
export interface LinkHandlers {
  cmd(cmd: OverlayCmd, value?: unknown): void;
  /** sessions the app tracked, waiting for the website's History */
  sessions(list: SavedSession[]): void;
  /** an auto-pause time set on the overlay while the website was away */
  pendingIdle(p: PendingIdle): void;
  /** the app's session, live (null: the app stopped tracking) */
  mirror(snap: MirrorSnapshot | null): void;
  /** the website's Setup (to the tracker inside the app) */
  setup(bundle: SetupBundle): void;
  /** the link came up */
  connected(): void;
}

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

const MESSAGES = ['cmd', 'sessions', 'pendingIdle', 'mirror', 'setup'] as const;

export class DesktopLink {
  private ws: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  state: LinkState = 'off';
  constructor(private on: LinkHandlers, private onState: () => void) {}

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
    if (this.state === 'connected') { this.post('show'); return true; }
    // not linked yet (the app never connected from here): connect just long enough to see whether the app came up
    const probe = !this.wanted;
    if (probe) this.enable(true);
    const ok = await this.open();
    if (probe && !ok) this.enable(false);
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
  send(stats: unknown) { this.post('stats', { stats, inApp: inDesktopApp() }); }
  /** A short message on the overlay (why ▶ couldn't start, say). */
  notice(text: string) { this.post('notice', { text }); }
  /** the website's Setup, for the app's tracker */
  sendSetup(bundle: SetupBundle) { return this.post('setup', { bundle }); }
  /** a session the app's tracker just ended, for the website's History */
  sendSaved(session: SavedSession) { this.post('saved', { session }); }
  /** these sessions are in the website's History now */
  ack(ids: number[]) { this.post('ack', { ids }); }
  /** the app's tracker's session, for the website to show live */
  sendMirror(snap: MirrorSnapshot | null) { this.post('mirror', { snap }); }
  /** the website's buttons while the app tracks: they go to the app's tracker */
  sendCmd(cmd: OverlayCmd, value?: unknown) { this.post('cmd', { cmd, value }); }
  /** a diagnostics line for the app's own log file */
  sendDiag(line: string) { this.post('diag', { line }); }
  /** the overlay's auto-pause time is settled on the website */
  idleResolved() { this.post('idleResolved'); }

  private post(type: string, body: object = {}) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type, ...body }));
    return true;
  }
  private receive(m: { type?: string; [k: string]: unknown }) {
    if (!(MESSAGES as readonly string[]).includes(m.type ?? '')) return;
    if (m.type === 'cmd') { if ((OVERLAY_CMDS as readonly string[]).includes(m.cmd as string)) this.on.cmd(m.cmd as OverlayCmd, m.value); }
    else if (m.type === 'sessions') { if (Array.isArray(m.list)) this.on.sessions(m.list as SavedSession[]); }
    else if (m.type === 'pendingIdle') this.on.pendingIdle(m as unknown as PendingIdle);
    else if (m.type === 'mirror') this.on.mirror((m.snap ?? null) as MirrorSnapshot | null);
    else if (m.type === 'setup' && m.bundle && typeof m.bundle === 'object') this.on.setup(m.bundle as SetupBundle);
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
    ws.onopen = () => {
      this.set('connected');
      try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { console.warn('could not remember the desktop app', e); }
      this.on.connected();
    };
    ws.onmessage = e => {
      let m: unknown;
      try { m = JSON.parse(String(e.data)); } catch { console.warn('desktop app: unreadable message'); return; }
      if (m && typeof m === 'object') this.receive(m as { type?: string });
    };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.set(this.wanted ? 'connecting' : 'off'); this.later(); } };
    ws.onerror = () => ws.close();
  }
  private later() { if (this.wanted && !this.retry) this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 5000); }
}
