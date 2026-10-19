import { shadowText, snapCanvas, snapExtent, snapRaw, type LineSnap } from './logqueue';
import type { OcrEngine } from './ocr/engine';
import type { PaddleEngine } from './ocr/paddle';
import { lineQuality } from './parse';

/**
 * Reading one pickup-log line snapshot, the way each engine reads best (measured with dev/bench-log-ocr.mjs on party
 * recordings):
 * - PaddleOCR gets the original colour pixels, cropped to the text with a small margin: as many complete lines as the
 *   full-width crop but more confident and ~40% faster, and far better than a thresholded image (68% vs 48%). If that
 *   doesn't give a complete line, the full-width crop is tried; the better read wins (complete first, then confidence).
 * - Tesseract gets the thresholded image, then the high-contrast one.
 * `onCall` counts OCR calls. Returns the best text ('' when nothing usable).
 */
export async function readLogSnap(eng: OcrEngine, s: LineSnap, edge: number | null, onCall: () => void): Promise<string> {
  if (!eng.prefersRaw) {
    onCall();
    let t = await eng.read(snapCanvas(s), 'line');
    if (lineQuality(t) < 2 && s.hi) {
      onCall();
      const t2 = await eng.read(snapCanvas(s, true), 'line');
      if (lineQuality(t2) > lineQuality(t)) t = t2;
    }
    return t;
  }
  const pad = eng as PaddleEngine, ext = snapExtent(s), m = 6 * s.f / s.W;
  const tries = [
    ext ? snapRaw(s, Math.max(0, ext.x0 - m), Math.min(1, (edge ?? ext.x1) + m)) : null, // the text with a margin
    snapRaw(s), // the whole width
  ].filter((c): c is HTMLCanvasElement => !!c);
  let best = { text: '', conf: 0, q: -1 };
  for (const c of tries) {
    onCall();
    const r = await pad.readLine(c, 'line'), q = lineQuality(r.text);
    if (q > best.q || (q === best.q && r.conf > best.conf)) best = { text: r.text, conf: r.conf, q };
    if (best.q >= 2) break;
  }
  // still no proper line: a bright background (sand, sky, snow) swamps the colours, so read the text by its shadow
  if (best.q < 2 && tries[0]) {
    onCall();
    const r = await pad.readLine(shadowText(tries[0]), 'line'), q = lineQuality(r.text);
    if (q > best.q || (q === best.q && r.conf > best.conf)) best = { text: r.text, conf: r.conf, q };
  }
  return best.text;
}
