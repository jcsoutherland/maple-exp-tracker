import { useEffect, useRef, useState } from 'react';
import { fmtDur } from '../core/util';

/**
 * One series over session time (x = minutes). Area wash + 2px line, hairline grid, crosshair that snaps to the
 * nearest sample with a tooltip (value first, time second). Single series, so the title names it — no legend.
 */
export function MiniChart({ title, points, color, fmt, height = 110, empty }: {
  title: string; points: [number, number][]; color: string; fmt: (v: number) => string; height?: number;
  /** shown instead of the plot while there isn't enough data */
  empty?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(300);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(e => setW(Math.max(120, e[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pad = { l: 6, r: 6, t: 8, b: 18 }, H = height, iw = w - pad.l - pad.r, ih = H - pad.t - pad.b;
  const pts = points.length ? points : [[0, 0] as [number, number]];
  const xMax = Math.max(1e-6, pts[pts.length - 1][0]), yMax = Math.max(1, ...pts.map(p => p[1]));
  const X = (x: number) => pad.l + (x / xMax) * iw, Y = (y: number) => pad.t + ih - (y / yMax) * ih;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  const area = `${line}L${X(pts[pts.length - 1][0]).toFixed(1)},${pad.t + ih}L${X(pts[0][0]).toFixed(1)},${pad.t + ih}Z`;
  const last = pts[pts.length - 1], hp = hover != null ? pts[hover] : null;

  const onMove = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect(), x = ((e.clientX - r.left - pad.l) / iw) * xMax;
    let best = 0;
    pts.forEach((p, i) => { if (Math.abs(p[0] - x) < Math.abs(pts[best][0] - x)) best = i; });
    setHover(best);
  };

  return (
    <div className="mchart" ref={wrap}>
      <div className="mchart-head"><span>{title}</span><b>{empty ? '—' : fmt(last[1])}</b></div>
      {empty ? <div className="mchart-empty" style={{ height: H }}>{empty}</div> : <div style={{ position: 'relative' }}>
        <svg width={w} height={H} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={`${title}: ${fmt(last[1])}`}>
          {[0.5, 1].map(f => <line key={f} x1={pad.l} x2={w - pad.r} y1={pad.t + ih * (1 - f)} y2={pad.t + ih * (1 - f)} stroke="var(--line)" strokeWidth={1} />)}
          <line x1={pad.l} x2={w - pad.r} y1={pad.t + ih} y2={pad.t + ih} stroke="var(--line)" strokeWidth={1} />
          <path d={area} fill={color} opacity={0.1} />
          <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <text x={pad.l} y={H - 4} className="mchart-axis">0:00</text>
          <text x={w - pad.r} y={H - 4} textAnchor="end" className="mchart-axis">{fmtDur(xMax * 60000)}</text>
          {hp && <>
            <line x1={X(hp[0])} x2={X(hp[0])} y1={pad.t} y2={pad.t + ih} stroke="var(--mut)" strokeWidth={1} />
            <circle cx={X(hp[0])} cy={Y(hp[1])} r={4} fill={color} stroke="var(--panel)" strokeWidth={2} />
          </>}
        </svg>
        {hp && (
          <div className="mchart-tip" style={{ left: Math.min(w - 110, Math.max(0, X(hp[0]) - 50)) }}>
            <b>{fmt(hp[1])}</b><span>{fmtDur(hp[0] * 60000)}</span>
          </div>
        )}
      </div>}
    </div>
  );
}
