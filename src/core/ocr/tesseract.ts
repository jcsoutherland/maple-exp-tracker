import { createWorker, PSM, type Worker } from 'tesseract.js';
import type { OcrChar, OcrEngine, OcrKind } from './engine';

const PARAMS: Record<OcrKind, Partial<Record<string, string>>> = {
  num: { tessedit_char_whitelist: '0123456789,.[]/%', tessedit_pageseg_mode: PSM.SINGLE_LINE },
  line: { tessedit_pageseg_mode: PSM.SINGLE_LINE },
};
/** A single line never takes this long; past it the worker is assumed stuck and is restarted. */
const JOB_TIMEOUT_MS = 6000;

/**
 * Two Tesseract workers: one restricted to status-bar characters, one for general single-line text.
 * Jobs per worker run one at a time; a job that hangs is abandoned and its worker replaced, so a single bad image
 * can never freeze the read pipeline.
 */
export class TesseractEngine implements OcrEngine {
  readonly name = 'Tesseract';
  private workers: Partial<Record<OcrKind, Promise<Worker>>> = {};
  private queue: Partial<Record<OcrKind, Promise<unknown>>> = {};

  private spawn(kind: OcrKind) {
    const w = createWorker('eng', 1).then(async wk => { await wk.setParameters(PARAMS[kind]); return wk; });
    this.workers[kind] = w;
    return w;
  }

  async init() {
    if (this.workers.num) return;
    await Promise.all([this.spawn('num'), this.spawn('line')]);
  }

  read(canvas: HTMLCanvasElement, kind: OcrKind): Promise<string> {
    return this.readChars(canvas, kind).then(r => r.text);
  }

  readChars(canvas: HTMLCanvasElement, kind: OcrKind): Promise<{ text: string; chars: OcrChar[] }> {
    const none = { text: '', chars: [] as OcrChar[] };
    if (!this.workers[kind] || canvas.width < 4 || canvas.height < 4) return Promise.resolve(none);
    const job = (this.queue[kind] || Promise.resolve()).then(async () => {
      const wp = this.workers[kind]!;
      let timer = 0;
      const timeout = new Promise<'timeout'>(res => { timer = window.setTimeout(() => res('timeout'), JOB_TIMEOUT_MS); });
      const r = await Promise.race([wp.then(w => w.recognize(canvas)), timeout]);
      clearTimeout(timer);
      if (r === 'timeout') {
        console.warn(`OCR ${kind} worker stuck; restarting it`);
        wp.then(w => w.terminate()).catch(() => undefined);
        this.spawn(kind);
        return none;
      }
      const chars = (r.data.symbols || []).map(s => ({ c: s.text, x0: s.bbox.x0, y0: s.bbox.y0, x1: s.bbox.x1, y1: s.bbox.y1 }));
      return { text: r.data.text.trim(), chars };
    });
    this.queue[kind] = job.catch(() => undefined);
    return job.catch(() => none);
  }

  async dispose() {
    await Promise.all(Object.values(this.workers).map(p => p!.then(w => w.terminate()).catch(() => undefined)));
    this.workers = {};
  }
}
