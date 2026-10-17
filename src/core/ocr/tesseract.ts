import { createWorker, PSM, type Worker } from 'tesseract.js';
import type { OcrChar, OcrEngine, OcrKind } from './engine';

const PARAMS: Record<OcrKind, Partial<Record<string, string>>> = {
  num: { tessedit_char_whitelist: '0123456789,.[]/%', tessedit_pageseg_mode: PSM.SINGLE_LINE },
  line: { tessedit_pageseg_mode: PSM.SINGLE_LINE },
};
/** workers per kind: log lines can come in bursts (a party's pickup log), so they get two readers working in parallel */
const POOL: Record<OcrKind, number> = { num: 1, line: 2 };
/** A single line never takes this long; past it the worker is assumed stuck and is restarted. */
const JOB_TIMEOUT_MS = 6000;

interface Slot { worker: Promise<Worker>; queue: Promise<unknown>; pending: number }

/**
 * Tesseract workers: one restricted to status-bar characters, two for general single-line text. Each worker runs one
 * job at a time and a job goes to the least busy worker of its kind; a job that hangs is abandoned and its worker
 * replaced, so a single bad image can never freeze the read pipeline.
 */
export class TesseractEngine implements OcrEngine {
  readonly name = 'Tesseract';
  private slots: Partial<Record<OcrKind, Slot[]>> = {};

  private spawn(kind: OcrKind) {
    return createWorker('eng', 1).then(async wk => { await wk.setParameters(PARAMS[kind]); return wk; });
  }

  async init() {
    if (this.slots.num) return;
    for (const kind of ['num', 'line'] as OcrKind[]) this.slots[kind] = Array.from({ length: POOL[kind] }, () => ({ worker: this.spawn(kind), queue: Promise.resolve(), pending: 0 }));
    await Promise.all(Object.values(this.slots).flat().map(s => s!.worker));
  }

  read(canvas: HTMLCanvasElement, kind: OcrKind): Promise<string> {
    return this.readChars(canvas, kind).then(r => r.text);
  }

  readChars(canvas: HTMLCanvasElement, kind: OcrKind): Promise<{ text: string; chars: OcrChar[] }> {
    const none = { text: '', chars: [] as OcrChar[] };
    const pool = this.slots[kind];
    if (!pool || canvas.width < 4 || canvas.height < 4) return Promise.resolve(none);
    const slot = pool.reduce((a, b) => (b.pending < a.pending ? b : a));
    slot.pending++;
    const job = slot.queue.then(async () => {
      const wp = slot.worker;
      let timer = 0;
      const timeout = new Promise<'timeout'>(res => { timer = window.setTimeout(() => res('timeout'), JOB_TIMEOUT_MS); });
      const r = await Promise.race([wp.then(w => w.recognize(canvas)), timeout]);
      clearTimeout(timer);
      if (r === 'timeout') {
        console.warn(`OCR ${kind} worker stuck; restarting it`);
        wp.then(w => w.terminate()).catch(() => undefined);
        slot.worker = this.spawn(kind);
        return none;
      }
      const chars = (r.data.symbols || []).map(s => ({ c: s.text, x0: s.bbox.x0, y0: s.bbox.y0, x1: s.bbox.x1, y1: s.bbox.y1 }));
      return { text: r.data.text.trim(), chars };
    }).finally(() => { slot.pending--; });
    slot.queue = job.catch(() => undefined);
    return job.catch(() => none);
  }

  async dispose() {
    await Promise.all(Object.values(this.slots).flat().map(s => s!.worker.then(w => w.terminate()).catch(() => undefined)));
    this.slots = {};
  }
}
