/**
 * The link to the desktop overlay app (desktop/ in this repo): a borderless, always-on-top window with no browser
 * address strip. The app listens on this computer only (127.0.0.1); the tracker sends it the overlay's numbers once a
 * second and takes its Start / Pause buttons back. Only when switched on (Setup tab) or inside the app itself, so
 * nobody else's browser ever reaches for a local port.
 */

/** must match PORT in desktop/main.js */
export const DESKTOP_PORT = 47821;
/** the app's download: the latest GitHub release */
export const DESKTOP_DOWNLOAD = 'https://github.com/jcsoutherland/maple-exp-tracker/releases/latest/download/MapleTrackerOverlay.exe';
/** this page is the tracker running inside the desktop app (standalone mode) */
export const inDesktopApp = () => new URLSearchParams(location.search).has('desktop');

export type LinkState = 'off' | 'connecting' | 'connected';

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
  send(stats: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'stats', stats }));
  }

  private set(s: LinkState) { if (s !== this.state) { this.state = s; this.onState(); } }
  private connect() {
    if (!this.wanted) return;
    this.set('connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(`ws://127.0.0.1:${DESKTOP_PORT}`); } catch { this.later(); return; }
    this.ws = ws;
    ws.onopen = () => this.set('connected');
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
