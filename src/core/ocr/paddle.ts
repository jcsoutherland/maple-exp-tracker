import type { OcrChar, OcrEngine, OcrKind } from './engine';
import { fetchFirst, MIRROR } from '../mirror';

/**
 * PaddleOCR's English text-line recogniser (PP-OCRv5 mobile, Apache-2.0) running in the browser with onnxruntime-web
 * (WebAssembly). We already know where each line is, so only the recogniser is needed (no text detection): ~8 MB of
 * model, read from our data mirror (dev/mirror-data.mjs) and fetched once. A neural model trained on noisy real-world
 * text, it copes far better than Tesseract with small game text over busy scenery.
 */
const HF = 'https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/english/';
/** the height the model reads lines at by default; width follows the line's aspect ratio */
const H = 48;

/** A recognised line with its confidence: the mean probability of the characters chosen (0–1). */
export interface PaddleRead { text: string; chars: OcrChar[]; conf: number }
/** characters the status-bar readers ('num') may return */
const NUM_OK = /[0-9,.[\]/%]/;

type Ort = typeof import('onnxruntime-web/wasm');

export class PaddleEngine implements OcrEngine {
  readonly name = 'PaddleOCR';
  readonly prefersRaw = true;
  private ort: Ort | null = null;
  private session: import('onnxruntime-web/wasm').InferenceSession | null = null;
  private dict: string[] = [];
  /** one inference at a time (single-threaded WebAssembly) */
  private queue: Promise<unknown> = Promise.resolve();
  private scratch = document.createElement('canvas');

  async init() {
    if (this.session) return;
    const [ort, wasm] = await Promise.all([import('onnxruntime-web/wasm'), import('onnxruntime-web/ort-wasm-simd-threaded.wasm?url')]);
    ort.env.wasm.wasmPaths = { wasm: wasm.default };
    ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which GitHub Pages can't provide
    const [model, dict] = await Promise.all([
      fetchFirst([MIRROR + 'models/en_rec.onnx', HF + 'rec.onnx']),
      fetchFirst([MIRROR + 'models/en_dict.txt', HF + 'dict.txt']),
    ]);
    if (!model || !dict) throw new Error('PaddleOCR model unavailable');
    this.dict = (await dict.text()).split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l !== '');
    this.session = await ort.InferenceSession.create(new Uint8Array(await model.arrayBuffer()), { executionProviders: ['wasm'] });
    this.ort = ort;
  }

  read(canvas: HTMLCanvasElement, kind: OcrKind): Promise<string> {
    return this.readChars(canvas, kind).then(r => r.text);
  }

  readChars(canvas: HTMLCanvasElement, kind: OcrKind): Promise<{ text: string; chars: OcrChar[] }> {
    return this.readLine(canvas, kind);
  }

  /** Read one line, with confidence; `height` overrides the model's input height. */
  readLine(canvas: HTMLCanvasElement, kind: OcrKind = 'line', height = H): Promise<PaddleRead> {
    const job = this.queue.then(() => this.recognise(canvas, kind, height));
    this.queue = job.catch(() => undefined);
    return job.catch(() => ({ text: '', chars: [], conf: 0 }));
  }

  /** Resize the line to H px high, normalise to [-1, 1], run the model, and CTC-decode the best path. */
  private async recognise(canvas: HTMLCanvasElement, kind: OcrKind, H: number): Promise<PaddleRead> {
    const ort = this.ort, session = this.session;
    if (!ort || !session || canvas.width < 4 || canvas.height < 4) return { text: '', chars: [], conf: 0 };
    const w = Math.max(8, Math.min(1600, Math.round(canvas.width * H / canvas.height)));
    const c = this.scratch;
    c.width = w; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(canvas, 0, 0, w, H);
    const px = g.getImageData(0, 0, w, H).data, n = w * H, data = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let ch = 0; ch < 3; ch++) data[ch * n + i] = px[i * 4 + ch] / 127.5 - 1;
    const input = new ort.Tensor('float32', data, [1, 3, H, w]);
    const out = await session.run({ [session.inputNames[0]]: input });
    const t = out[session.outputNames[0]], [, T, C] = t.dims as number[], p = t.data as Float32Array;
    // classes: 0 = blank, 1..dict = characters, and a trailing space class when the model has one
    const chars: OcrChar[] = [];
    let prev = 0, text = '', psum = 0;
    for (let s = 0; s < T; s++) {
      let best = 0, bv = -Infinity;
      for (let k = 0; k < C; k++) { const v = p[s * C + k]; if (v > bv) { bv = v; best = k; } }
      if (best !== 0 && best !== prev) {
        const ch = best - 1 < this.dict.length ? this.dict[best - 1] : ' ';
        if (kind !== 'num' || NUM_OK.test(ch)) {
          text += ch; psum += bv;
          // each output step covers an equal slice of the line's width
          chars.push({ c: ch, x0: s * canvas.width / T, x1: (s + 1) * canvas.width / T, y0: 0, y1: canvas.height - 1 });
        }
      }
      prev = best;
    }
    return { text: text.trim(), chars, conf: chars.length ? psum / chars.length : 0 };
  }

  async dispose() {
    await this.session?.release();
    this.session = null;
  }
}
