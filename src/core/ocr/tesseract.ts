import { createWorker, PSM, type Worker } from 'tesseract.js';
import type { OcrEngine, OcrKind } from './engine';

/** Two Tesseract workers: one restricted to status-bar characters, one for general single-line text. */
export class TesseractEngine implements OcrEngine {
  readonly name = 'Tesseract';
  private num: Worker | null = null;
  private text: Worker | null = null;
  private queue = new Map<Worker, Promise<unknown>>();

  async init() {
    if (this.num) return;
    this.num = await createWorker('eng', 1);
    await this.num.setParameters({ tessedit_char_whitelist: '0123456789,.[]/%', tessedit_pageseg_mode: PSM.SINGLE_LINE });
    this.text = await createWorker('eng', 1);
    await this.text.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
  }

  read(canvas: HTMLCanvasElement, kind: OcrKind): Promise<string> {
    const w = kind === 'num' ? this.num : this.text;
    if (!w) return Promise.resolve('');
    // each worker handles one job at a time; chain so callers can fire concurrently
    const job = (this.queue.get(w) || Promise.resolve()).then(async () => (await w.recognize(canvas)).data.text.trim());
    this.queue.set(w, job.catch(() => undefined));
    return job;
  }

  async dispose() {
    await Promise.all([this.num?.terminate(), this.text?.terminate()]);
    this.num = this.text = null;
  }
}
