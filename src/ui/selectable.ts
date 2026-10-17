export interface FracRect { x: number; y: number; w: number; h: number }

/** Drag-to-select a rectangle on a canvas, reported as fractions of the canvas (= fractions of the frame shown). */
export function attachSelect(c: HTMLCanvasElement, onMove: (r: FracRect) => void, onDone: (r: FracRect) => void) {
  let st: { x: number; y: number } | null = null;
  const pt = (e: PointerEvent) => {
    const b = c.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)) };
  };
  const rect = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  c.onpointerdown = e => { st = pt(e); c.setPointerCapture(e.pointerId); };
  c.onpointermove = e => { if (st) onMove(rect(st, pt(e))); };
  c.onpointerup = e => {
    if (!st) return;
    const r = rect(st, pt(e));
    st = null;
    if (r.w > 0.003 && r.h > 0.003) onDone(r);
  };
  return () => { c.onpointerdown = c.onpointermove = c.onpointerup = null; };
}
