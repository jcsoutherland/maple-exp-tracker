/**
 * Interval timers that keep running in a background tab. Browsers throttle main-thread timers in hidden tabs
 * (down to once a minute), but timers inside a Web Worker are not throttled.
 */
export class Ticker {
  private worker: Worker | null = null;
  private handlers = new Map<string, () => void>();
  private fallback: number[] = [];

  constructor() {
    try {
      const src = 'let t=[];onmessage=e=>{t.forEach(clearInterval);t=[];for(const[id,ms]of e.data)t.push(setInterval(()=>postMessage(id),ms))}';
      this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      this.worker.onmessage = e => this.handlers.get(e.data)?.();
    } catch { this.worker = null; }
  }

  /** Replace all timers with the given set: id → [intervalMs, handler]. */
  set(spec: Record<string, [number, () => void]>) {
    this.handlers = new Map(Object.entries(spec).map(([id, [, fn]]) => [id, fn]));
    const list = Object.entries(spec).map(([id, [ms]]) => [id, ms]);
    if (this.worker) this.worker.postMessage(list);
    else {
      this.fallback.forEach(clearInterval);
      this.fallback = Object.entries(spec).map(([, [ms, fn]]) => window.setInterval(fn, ms));
    }
  }

  stop() { this.set({}); }
}
