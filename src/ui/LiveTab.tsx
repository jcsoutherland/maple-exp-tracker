import { useEffect, useRef } from 'react';
import { MAP_MIN_EXP, potCost } from '../core/session';
import { fmtDur, fmtHM, fmtK, fmtN } from '../core/util';
import { useCtrl } from './hooks';

const EVC: Record<string, string> = { meso: '#f5c542', drop: '#c08cff', level: '#9bd34a', death: '#e5484d', map: '#ff7ab8', info: '#9097a8' };

export function LiveTab() {
  const c = useCtrl();
  const s = c.sess, t = c.tracker, id = c.identity;
  const { el, hr, r10 } = c.rates();
  const pc = s ? potCost(s, c.settings) : null;
  const rate = r10 || hr;
  const toGo = t?.total && t.exp != null ? t.total - t.exp : null;

  return (
    <section>
      <div className="card">
        <div className="row charin">
          <span className="mut">Character</span>
          <input value={id.name} placeholder="Name" onChange={e => c.setIdentity({ name: e.target.value })} />
          <span className="mut">Class</span>
          <input value={id.cls} placeholder="Class" onChange={e => c.setIdentity({ cls: e.target.value })} />
          <span className="mut">Lv</span>
          <input className="lv" type="number" min={1} max={250} value={id.level ?? ''} onChange={e => c.setIdentity({ level: +e.target.value || null })} />
          <button disabled={!c.capture.ready || c.ocrState !== 'ready'} onClick={() => c.identify()}>Read from screen</button>
          <span className="sp" />
          <span className="mut small">Map:</span> <b>{t ? t.mapName : '—'}</b>
        </div>
      </div>
      <div className="card">
        <div className="tiles">
          <Tile k="Session time" v={fmtDur(el)} s={s ? (s.paused ? 'paused' : 'started ' + new Date(s.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : ' '} />
          <Tile k="EXP gained" v={fmtN(s?.exp ?? 0)} s={s?.levelUps ? `${s.levelUps} level-up${s.levelUps > 1 ? 's' : ''}` : ' '} />
          <Tile k="EXP / hr" v={hr != null ? fmtK(hr) : '—'} s={'last 10 min: ' + (r10 != null ? fmtK(r10) : '—')} />
          <div className="tile">
            <div className="k">Level progress</div>
            <div className="v">{t?.pct != null ? t.pct.toFixed(2) + '%' : '—'}</div>
            <div className="s">{toGo != null && rate ? `ETA ${fmtHM(toGo / rate * 3.6e6)} · ${fmtN(toGo)} to go` : 'ETA —'}</div>
            <div className="bar"><i style={{ width: (t?.pct ?? 0) + '%' }} /></div>
          </div>
          <Tile k="Mesos (raw)" v={fmtN(s?.mesos ?? 0)} s={(s && el > 60000 ? fmtK(s.mesos / (el / 3.6e6)) : '—') + ' / hr'} />
          <Tile k="Pot cost" v={fmtN(pc?.total ?? 0)} s={s && pc ? `net ${fmtN(s.mesos - pc.total)} mesos` : ' '} />
          <div className="tile">
            <div className="k">HP / MP</div>
            <div className="v small">
              {t ? <><span style={{ color: 'var(--hp)' }}>{t.hp.cur ?? '?'}/{t.hp.max ?? '?'}</span> · <span style={{ color: 'var(--mp)' }}>{t.mp.cur ?? '?'}/{t.mp.max ?? '?'}</span></> : '—'}
            </div>
            <div className="s">{pc ? Object.values(pc.detail).map(d => `${d!.count} ${d!.name}`).join(' · ') : ' '}</div>
          </div>
          <div className="tile">
            <div className="k">EXP lost</div>
            <div className="v" style={{ color: 'var(--bad)' }}>{s?.expLost ? '-' + fmtN(s.expLost) : '0'}</div>
            <div className="s">{s?.deaths ? `${s.deaths} death${s.deaths > 1 ? 's' : ''} · net ${fmtN(s.exp - s.expLost)} EXP` : 'no deaths'}</div>
          </div>
        </div>
        <Spark points={s ? [...s.timeline, [el / 60000, s.exp]] : []} />
        <div className="perf">log checks {c.stats.logChecks} · OCR calls {c.stats.ocrCalls} · last log tick {c.stats.lastTickMs.toFixed(0)} ms</div>
      </div>
      <div className="grid2">
        <div className="card">
          <h3>EXP by map</h3>
          <table>
            <thead><tr><th>Map</th><th className="n">EXP</th><th className="n">%</th></tr></thead>
            <tbody>
              {s && Object.keys(s.maps).length ? Object.entries(s.maps).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                <tr key={k} className={v < MAP_MIN_EXP ? 'dim' : ''}><td>{k}</td><td className="n">{fmtN(v)}</td><td className="n">{(v / (s.exp || 1) * 100).toFixed(1)}</td></tr>
              )) : <tr><td colSpan={3} className="mut">No EXP yet.</td></tr>}
            </tbody>
          </table>
          <div className="mut small" style={{ marginTop: 6 }}>Maps under {fmtN(MAP_MIN_EXP)} EXP are dimmed and left out when the session is saved.</div>
        </div>
        <div className="card">
          <h3>Activity</h3>
          <div className="feed">
            {s?.events.slice(0, 40).map((e, i) => (
              <div key={i}><span className="t">{fmtDur(e.t)}</span><span style={{ color: EVC[e.type] }}>{e.text}</span></div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Tile({ k, v, s }: { k: string; v: string; s: string }) {
  return <div className="tile"><div className="k">{k}</div><div className="v">{v}</div><div className="s">{s}</div></div>;
}

function Spark({ points }: { points: [number, number][] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    const x = cv.getContext('2d')!;
    x.scale(dpr, dpr);
    x.clearRect(0, 0, w, h);
    if (points.length < 2) return;
    const pts = [...points].sort((a, b) => a[0] - b[0]);
    const mx = Math.max(1e-6, pts[pts.length - 1][0]), my = Math.max(1, ...pts.map(p => p[1]));
    const X = (p: [number, number]) => p[0] / mx * (w - 2) + 1, Y = (p: [number, number]) => h - 4 - p[1] / my * (h - 14);
    x.beginPath();
    pts.forEach((p, i) => (i ? x.lineTo(X(p), Y(p)) : x.moveTo(X(p), Y(p))));
    x.strokeStyle = '#9bd34a'; x.lineWidth = 2; x.stroke();
    x.lineTo(X(pts[pts.length - 1]), h); x.lineTo(X(pts[0]), h); x.closePath(); x.fillStyle = '#9bd34a22'; x.fill();
    x.fillStyle = '#9097a8'; x.font = '11px system-ui'; x.fillText('cumulative EXP · ' + fmtK(my), 4, 11);
  });
  return <canvas ref={ref} className="spark" style={{ marginTop: 12 }} />;
}
