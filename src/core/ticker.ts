/**
 * Interval timers that keep running in a background tab. Browsers throttle main-thread timers in hidden tabs
 * (down to once a minute), but timers inside a Web Worker are not throttled.
 */
export class Ticker {
  private worker: Worker | null = null;
  private handlers = new Map<string, () => void>();
  private fallback: number[] = [];
  /** when each timer last fired (for the diagnostics log) */
  readonly fired = new Map<string, number>();

  constructor() {
    try {
      const src = 'let t=[];onmessage=e=>{t.forEach(clearInterval);t=[];for(const[id,ms]of e.data)t.push(setInterval(()=>postMessage(id),ms))}';
      this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      this.worker.onmessage = e => { this.fired.set(e.data, Date.now()); this.handlers.get(e.data)?.(); };
    } catch { this.worker = null; }
  }

  /** Replace all timers with the given set: id → [intervalMs, handler]. */
  set(spec: Record<string, [number, () => void]>) {
    this.fired.clear();
    this.handlers = new Map(Object.entries(spec).map(([id, [, fn]]) => [id, fn]));
    const list = Object.entries(spec).map(([id, [ms]]) => [id, ms]);
    if (this.worker) this.worker.postMessage(list);
    else {
      this.fallback.forEach(clearInterval);
      this.fallback = Object.entries(spec).map(([id, [ms, fn]]) => window.setInterval(() => { this.fired.set(id, Date.now()); fn(); }, ms));
    }
  }

  stop() { this.set({}); }
  /** the timers running, and how many seconds ago each last fired */
  describe() {
    const now = Date.now();
    return [...this.handlers.keys()].map(id => `${id}:${this.fired.has(id) ? Math.round((now - this.fired.get(id)!) / 1000) + 's' : 'never'}`).join(',') || 'none';
  }
}
