/**
 * OCR backends sit behind this interface so the reader can be swapped (Tesseract today; a PaddleOCR/ONNX line
 * recogniser or a native desktop OCR later) without touching the tracking pipeline.
 */
export type OcrKind = 'num' | 'line';

export interface OcrEngine {
  readonly name: string;
  init(): Promise<void>;
  /** Recognise a single line of text in a prepared (dark-on-light) canvas. */
  read(canvas: HTMLCanvasElement, kind: OcrKind): Promise<string>;
  dispose(): Promise<void>;
}
