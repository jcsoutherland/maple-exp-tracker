import { useEffect, useRef, useState } from 'react';
import * as store from '../core/storage';
import { attachSelect, type FracRect } from './selectable';
import { toast, useCtrl } from './hooks';

/** Drag a box around the character on a frozen frame; saved (≤160px tall) as the character's history picture. */
export function SnapshotModal({ name, onClose }: { name: string; onClose: () => void }) {
  const c = useCtrl();
  const cv = useRef<HTMLCanvasElement>(null);
  const [img] = useState(() => c.capture.snapshot());
  const [rect, setRect] = useState<FracRect | null>(null);

  const draw = (r: FracRect | null) => {
    const el = cv.current;
    if (!el) return;
    el.height = Math.round(el.width * img.height / img.width);
    const x = el.getContext('2d')!;
    x.drawImage(img, 0, 0, el.width, el.height);
    if (r) { x.strokeStyle = '#f5a623'; x.lineWidth = 2; x.strokeRect(r.x * el.width, r.y * el.height, r.w * el.width, r.h * el.height); }
  };
  useEffect(() => draw(rect));
  useEffect(() => (cv.current ? attachSelect(cv.current, r => draw(r), setRect) : undefined), []);

  const save = () => {
    if (!rect) return;
    const W = img.width, H = img.height, sw = rect.w * W, sh = rect.h * H, sc = Math.min(1, 160 / sh), o = document.createElement('canvas');
    o.width = Math.round(sw * sc); o.height = Math.round(sh * sc);
    const x = o.getContext('2d')!;
    x.imageSmoothingEnabled = false;
    x.drawImage(img, rect.x * W, rect.y * H, sw, sh, 0, 0, o.width, o.height);
    const ch = store.loadChars();
    ch[name] = { ...ch[name], snap: o.toDataURL('image/png') };
    store.saveChars(ch);
    c.historyVersion++; c.notify();
    toast('Snapshot saved');
    onClose();
  };

  return (
    <div className="modal">
      <div className="card">
        <h3>Character snapshot: drag a box around your character</h3>
        <canvas ref={cv} id="snapCanvas" width={960} height={540} />
        <div className="row" style={{ marginTop: 10 }}>
          <span className="mut small">For: {name}</span><span className="sp" />
          <button onClick={onClose}>Skip</button>
          <button className="pri" disabled={!rect} onClick={save}>Save snapshot</button>
        </div>
      </div>
    </div>
  );
}
