import { useMemo } from 'react';
import { MAP_MIN_EXP, potCost } from '../core/session';
import { fmtDur, fmtHM, fmtK, fmtN } from '../core/util';
import { CharacterStage } from './CharacterStage';
import { useCtrl } from './hooks';
import { MiniChart } from './MiniChart';

const EVC: Record<string, string> = { meso: '#f5c542', drop: '#c08cff', level: '#9bd34a', death: '#e5484d', map: '#ff7ab8', info: '#9097a8' };
// chart hues: validated (dark palette, panel #1d2029) — each chart is one series, so no legend
const C_EXP = '#199e70', C_MESO = '#c98500', C_RATE = '#3987e5';

export function LiveTab() {
  const c = useCtrl();
  const s = c.sess, t = c.tracker, id = c.identity;
  const { el, hr, r10 } = c.rates();
  const pc = s ? potCost(s, c.settings) : null;
  const rate = r10 || hr;
  const toGo = t?.total && t.exp != null ? t.total - t.exp : null;
  const mesoHr = s && el > 60000 ? s.mesos / (el / 3.6e6) : null;

  // series from the 30 s timeline plus the live point
  const tl = useMemo(() => (s ? [...s.timeline, [el / 60000, s.exp, s.mesos] as [number, number, number]] : []), [s, el, s?.exp, s?.mesos]);
  const expPts = tl.map(p => [p[0], p[1]] as [number, number]);
  const mesoPts = tl.map(p => [p[0], p[2] ?? 0] as [number, number]);
  const ratePts = tl.flatMap((p, i) => {
    if (p[0] < 1) return [];
    const j = tl.findIndex(q => p[0] - q[0] <= 10); // 10-minute window (or since start)
    const a = tl[j];
    return i > j && p[0] > a[0] ? [[p[0], (p[1] - a[1]) / ((p[0] - a[0]) / 60)] as [number, number]] : [];
  });

  return (
    <section>
      <div className="row charin card slim">
        <span className="mut">Character</span>
        <input value={id.name} placeholder="Name" onChange={e => c.setIdentity({ name: e.target.value, nameTyped: !!e.target.value.trim() })} />
        <span className="mut">Class</span>
        <input value={id.cls} placeholder="Class" onChange={e => c.setIdentity({ cls: e.target.value })} />
        <span className="mut">Lv</span>
        <input className="lv" type="number" min={1} max={250} value={id.level ?? ''} onChange={e => c.setIdentity({ level: +e.target.value || null })} />
        <span className="mut">Gender</span>
        <select value={id.gender ?? 0} title="Gender of your rolled character (changing it rolls a new look)" onChange={e => c.setIdentity({ gender: +e.target.value as 0 | 1 })}>
          <option value={0}>Male</option>
          <option value={1}>Female</option>
        </select>
        <button disabled={!c.capture.ready || c.ocrState !== 'ready'} onClick={() => c.identify()}>Read from screen</button>
      </div>

      <div className="card sheet">
        <div className="sheet-hero">
          <CharacterStage />
          <div className="nameplate">
            <span className="lvbadge">Lv {s?.level ?? id.level ?? '?'}</span>
            <b>{id.name || 'Unknown'}</b>
            <span className="mut">{id.cls || '—'}</span>
          </div>
          <div className="xpbar">
            <div className="xpbar-fill" style={{ width: (t?.pct ?? 0) + '%' }} />
            <span>{t?.pct != null ? `EXP ${t.pct.toFixed(2)}%` : 'EXP —'}</span>
          </div>
          <div className="mut small">{toGo != null && rate ? `Level up in ~${fmtHM(toGo / rate * 3.6e6)} · ${fmtN(toGo)} EXP to go` : ' '}</div>
          <div className="mut small">📍 {t ? t.mapName : '—'}</div>
        </div>
        <div className="sheet-stats">
          <Stat k="Session" v={fmtDur(el)} s={s ? (s.paused ? 'paused' : 'since ' + new Date(s.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : ''} />
          <Stat k="EXP gained" v={fmtN(s?.exp ?? 0)} s={s?.levelUps ? `${s.levelUps} level-up${s.levelUps > 1 ? 's' : ''} 🎉` : ''} accent={C_EXP} />
          <Stat k="EXP / hr" v={hr != null ? fmtK(hr) : '—'} s={'last 10 min ' + (r10 != null ? fmtK(r10) : '—')} accent={C_RATE} />
          <Stat k="Mesos" v={fmtN(s?.mesos ?? 0)} s={(mesoHr != null ? fmtK(mesoHr) : '—') + ' / hr'} accent={C_MESO} />
          <Stat k="Potions" v={pc?.total ? '-' + fmtN(pc.total) : '0'} s={pc ? Object.values(pc.detail).map(d => `${d!.count} ${d!.name}`).join(' · ') : ''} />
          <Stat k="Net mesos" v={s && pc ? fmtN(s.mesos - pc.total) : '0'} s="after potions" />
          <div className="stat">
            <div className="k">HP / MP</div>
            <div className="v sm">{t ? <><span style={{ color: 'var(--hp)' }}>{t.hp.cur ?? '?'}/{t.hp.max ?? '?'}</span> · <span style={{ color: 'var(--mp)' }}>{t.mp.cur ?? '?'}/{t.mp.max ?? '?'}</span></> : '—'}</div>
            <div className="s">&nbsp;</div>
          </div>
          <Stat k="EXP lost" v={s?.expLost ? '-' + fmtN(s.expLost) : '0'} s={s?.deaths ? `${s.deaths} death${s.deaths > 1 ? 's' : ''} · net ${fmtN(s.exp - s.expLost)}` : 'no deaths'} bad={!!s?.expLost} />
        </div>
      </div>

      <div className="charts3">
        <div className="card"><MiniChart title="EXP gained" points={expPts} color={C_EXP} fmt={v => fmtN(v)} /></div>
        <div className="card"><MiniChart title="EXP / hr (10-min window)" points={ratePts.length ? ratePts : [[0, 0]]} color={C_RATE} fmt={v => fmtK(v)} empty={ratePts.length < 2 ? "Needs about a minute of data" : undefined} /></div>
        <div className="card"><MiniChart title="Mesos picked up" points={mesoPts} color={C_MESO} fmt={v => fmtN(v)} /></div>
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
          <div className="perf">log checks {c.stats.logChecks} · OCR calls {c.stats.ocrCalls} · last log tick {c.stats.lastTickMs.toFixed(0)} ms</div>
        </div>
      </div>
    </section>
  );
}

function Stat({ k, v, s, accent, bad }: { k: string; v: string; s: string; accent?: string; bad?: boolean }) {
  return (
    <div className="stat">
      <div className="k">{accent && <i className="key" style={{ background: accent }} />}{k}</div>
      <div className="v" style={bad ? { color: 'var(--bad)' } : undefined}>{v}</div>
      <div className="s">{s || ' '}</div>
    </div>
  );
}
