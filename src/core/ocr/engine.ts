/**
 * OCR backends sit behind this interface so the reader can be swapped (Tesseract today; a PaddleOCR/ONNX line
 * recogniser or a native desktop OCR later) without touching the tracking pipeline.
 */
export type OcrKind = 'num' | 'line';
/** one recognised character and its box in the canvas */
export interface OcrChar { c: string; x0: number; y0: number; x1: number; y1: number }

export interface OcrEngine {
  readonly name: string;
  init(): Promise<void>;
  /** Recognise a single line of text in a prepared (dark-on-light) canvas. */
  read(canvas: HTMLCanvasElement, kind: OcrKind): Promise<string>;
  /** Like read(), plus each character's box (for checking look-alike letters against the pixels). */
  readChars(canvas: HTMLCanvasElement, kind: OcrKind): Promise<{ text: string; chars: OcrChar[] }>;
  dispose(): Promise<void>;
}
