import { AUTO_PAUSE_OFF_WHY, canAutoPause, CLASS_GROUPS, CLASSES, featureOn, MAX_LEVEL, type Feature } from '../core/config';
import { useMemo } from 'react';
import { MAP_MIN_EXP, potCost } from '../core/session';
import { fmtDur, fmtHM, fmtK, fmtN } from '../core/util';
import { CharacterStage } from './CharacterStage';
import { useCtrl } from './hooks';
import { MiniChart } from './MiniChart';
import { MonsterPanel } from './MonsterCard';
import { PotionPanel } from './PotionPanel';
import { GoalPanel, KillsPanel } from './GoalPanel';
import { LootProfit } from './LootProfit';
import { NumberInput } from './NumberInput';
import { SessionBar } from './SessionBar';
import { celebrateLevel } from './fireworks';

const EVC: Record<string, string> = { meso: '#f5c542', drop: '#c08cff', level: '#9bd34a', death: '#e5484d', map: '#ff7ab8', info: '#9097a8' };
// chart hues: validated on the dark panels — each chart is one series, so no legend
const C_EXP = '#199e70', C_MESO = '#c98500', C_RATE = '#3987e5';

export function LiveTab() {
  const c = useCtrl();
  const s = c.sess, t = c.tracker, id = c.identity, loading = c.loading;
  // with no session running, the last one stays up for review until the next one starts
  const last = s ? null : c.lastFinished, d = s ?? last;
  const { el, hr, r10 } = last ? { el: last.activeMs, hr: last.activeMs > 60000 ? last.exp / (last.activeMs / 3.6e6) : null, r10: null } : c.rates();
  const pc = d ? potCost(d, c.settings) : null;
  const rate = r10 || hr;
  // features switched off on the Setup tab leave the dashboard
  const on = (f: Feature) => featureOn(c.settings, f);
  const toGo = t?.total && t.exp != null ? t.total - t.exp : null;
  const mesoHr = d && el > 60000 ? d.mesos / (el / 3.6e6) : null;
  const xpPct = Math.max(0, Math.min(100, t?.pct ?? 0)), xpText = t?.pct != null ? `EXP ${t.pct.toFixed(2)}%` : 'EXP —';

  // series from the 30 s timeline plus the live point
  const tl = useMemo(() => (d ? [...d.timeline, ...(s ? [[el / 60000, s.exp, s.mesos] as [number, number, number]] : [])] : []), [d, s, el, s?.exp, s?.mesos]);
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
        <select value={id.cls} onChange={e => c.setIdentity({ cls: e.target.value })}>
          {!id.cls && <option value="">Choose…</option>}
          {id.cls && !CLASSES.includes(id.cls) && <option value={id.cls}>{id.cls}</option>}
          {CLASS_GROUPS.map(([branch, jobs]) => <optgroup key={branch} label={branch}>{jobs.map(([j, lv]) => <option key={j} value={j}>{lv >= 70 ? '  ↳ ' : ''}{j} (Lv {lv})</option>)}</optgroup>)}
        </select>
        <span className="mut">Lv</span>
        <NumberInput className="lv" min={1} max={MAX_LEVEL} value={id.level} onChange={v => c.setIdentity({ level: v })} />
        <span className="mut">Gender</span>
        <select value={id.gender ?? 0} title="Gender of your rolled character (changing it rolls a new look)" onChange={e => c.setIdentity({ gender: +e.target.value as 0 | 1 })}>
          <option value={0}>Male</option>
          <option value={1}>Female</option>
        </select>
        <button disabled={!c.capture.ready || c.ocrState !== 'ready'} onClick={() => c.identify()}>Read from screen</button>
        <span className="sp" />
        <label className="idlecfg" title={canAutoPause(c.settings) ? "Pause the session after this many seconds without EXP or loot (0 = never). It resumes by itself when EXP moves again, and idle time isn't counted." : AUTO_PAUSE_OFF_WHY}>
          <span className="mut">Auto-pause after</span>
          <NumberInput className="lv" min={0} max={3600} step={5} value={c.settings.idlePauseSec} onChange={v => c.updateSettings({ idlePauseSec: v })}
            disabled={!canAutoPause(c.settings)} title={canAutoPause(c.settings) ? undefined : AUTO_PAUSE_OFF_WHY} />
          <span className="mut" title={canAutoPause(c.settings) ? undefined : AUTO_PAUSE_OFF_WHY}>{!canAutoPause(c.settings) ? 's (off: see why)' : c.settings.idlePauseSec ? 's idle' : 's (off)'}</span>
        </label>
      </div>

      <div className="dash-wrap">
      {loading && (
        <div className="dash-loading" role="status" aria-live="polite">
          <div className="dl-box">
            <div className="dl-label">{loading.label}…</div>
            <div className="dl-bar"><div style={{ width: loading.pct + '%' }} /></div>
          </div>
        </div>
      )}
      <div className={'dash' + (loading ? ' hidden' : '')}>
      <div className="card sheet">
        <div className="sheet-hero">
          <CharacterStage />
          <div className="nameplate">
            <span className="lvbadge">Lv {s?.level ?? id.level ?? '?'}</span>
            <b>{id.name || 'Unknown'}</b>
            <span className="mut">{id.cls || '—'}</span>
          </div>
          <div className="xpbar">
            <span>{xpText}</span>
            {/* the dark copy is as wide as the whole bar, so it lines up with the light one underneath */}
            {xpPct > 0 && <div className="xpbar-fill" style={{ width: xpPct + '%' }}><span style={{ width: 10000 / xpPct + '%' }}>{xpText}</span></div>}
          </div>
          <div className="mut small">{on('levelGoal') && toGo != null && rate ? `Level up in ~${fmtHM(toGo / rate * 3.6e6)} · ${fmtN(toGo)} EXP to go` : ' '}</div>
          <div className="mut small">📍 {t ? t.mapName : '—'}</div>
          {on('monsters') && <MonsterPanel />}
        </div>
        <div className="sheet-right">
        <SessionBar />
        <div className="sheet-stats">
          <Stat k={last ? 'Last session' : 'Session'} v={fmtDur(el)} s={s ? (s.paused ? 'paused' : 'since ' + new Date(s.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
            : last ? 'ended ' + new Date(last.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''} />
          {on('expGain') && <Stat k="EXP gained" v={fmtN(d?.exp ?? 0)} s={d?.levelUps ? `${d.levelUps} level-up${d.levelUps > 1 ? 's' : ''} 🎉` : ''} accent={C_EXP}
            onSub={d?.levelUps && d.level ? () => celebrateLevel(d.level! - 1, d.level!) : undefined} subTitle="Click to see the level-up animation again" />}
          {on('expRate') && <Stat k="EXP / hr" v={hr != null ? fmtK(hr) : '—'} s={'last 10 min ' + (r10 != null ? fmtK(r10) : '—')} accent={C_RATE} />}
          {on('mesos') && <Stat k="Mesos" v={fmtN(d?.mesos ?? 0)} s={(mesoHr != null ? fmtK(mesoHr) : '—') + ' / hr'} accent={C_MESO} />}
          {on('potions') && <Stat k="Potions" v={pc?.total ? '-' + fmtN(pc.total) : '0'} s={pc ? `${fmtN(pc.items.reduce((a, i) => a + i.count, 0))} used` : ''} />}
          {on('mesos') && <Stat k="Net mesos" v={d && pc ? fmtN(d.mesos - pc.total) : '0'} s="after potions" />}
          {on('potions') && <div className="stat">
            <div className="k">HP / MP</div>
            <div className="v sm">{t ? <><span style={{ color: 'var(--hp)' }}>{t.hp.cur ?? '?'}/{t.hp.max ?? '?'}</span> · <span style={{ color: 'var(--mp)' }}>{t.mp.cur ?? '?'}/{t.mp.max ?? '?'}</span></> : '—'}</div>
            <div className="s">&nbsp;</div>
          </div>}
          {on('expLost') && <Stat k="EXP lost" v={d?.expLost ? '-' + fmtN(d.expLost) : '0'} s={d?.deaths ? `${d.deaths} death${d.deaths > 1 ? 's' : ''} · net ${fmtN(d.exp - d.expLost)}` : 'no deaths'} bad={!!d?.expLost} />}
        </div>
        {on('potions') && <PotionPanel />}
        {(on('levelGoal') || on('kills')) && <div className="sheet-extra">
          {on('levelGoal') && <GoalPanel />}
          {on('kills') && <KillsPanel />}
        </div>}
        </div>
      </div>

      {on('graphs') && <div className="charts3">
        <div className="card"><MiniChart title="EXP gained" points={expPts} color={C_EXP} fmt={v => fmtN(v)} /></div>
        <div className="card"><MiniChart title="EXP / hr (10-min window)" points={ratePts.length ? ratePts : [[0, 0]]} color={C_RATE} fmt={v => fmtK(v)} empty={ratePts.length < 2 ? "Needs about a minute of data" : undefined} /></div>
        {on('mesos') && <div className="card"><MiniChart title="Mesos picked up" points={mesoPts} color={C_MESO} fmt={v => fmtN(v)} /></div>}
      </div>}

      {(on('expByMap') || on('activity')) && <div className="grid2">
        {on('expByMap') && <div className="card">
          <h3>EXP by map</h3>
          <table>
            <thead><tr><th>Map</th><th className="n">EXP</th><th className="n">%</th></tr></thead>
            <tbody>
              {d && Object.keys(d.maps).length ? Object.entries(d.maps).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                <tr key={k} className={v < MAP_MIN_EXP ? 'dim' : ''}><td>{k}</td><td className="n">{fmtN(v)}</td><td className="n">{(v / (d.exp || 1) * 100).toFixed(1)}</td></tr>
              )) : <tr><td colSpan={3} className="mut">No EXP yet.</td></tr>}
            </tbody>
          </table>
          <div className="mut small" style={{ marginTop: 6 }}>Maps under {fmtN(MAP_MIN_EXP)} EXP are dimmed and left out when the session is saved.</div>
        </div>}
        {on('activity') && <div className="card">
          <h3>Activity</h3>
          <div className="feed">
            {s?.events.slice(0, 40).map((e, i) => (
              <div key={i}><span className="t">{fmtDur(e.t)}</span><span style={{ color: EVC[e.type] }}>{e.text}</span></div>
            ))}
          </div>
          <div className="perf">log checks {c.stats.logChecks} · read by font {c.stats.logMatched} · OCR calls {c.stats.ocrCalls} · EXP lines skipped {c.stats.expSkipped} · log queue {c.stats.logBacklog}{c.stats.logDropped ? ` · dropped ${c.stats.logDropped}` : ''} · last log tick {c.stats.lastTickMs.toFixed(0)} ms</div>
        </div>}
      </div>}

      {(on('mesos') || on('drops')) && <LootProfit />}
      </div>
      </div>
    </section>
  );
}

/** A stat tile; `onSub` makes the line under the value clickable (the level-up count replays the celebration). */
function Stat({ k, v, s, accent, bad, onSub, subTitle }: { k: string; v: string; s: string; accent?: string; bad?: boolean; onSub?: () => void; subTitle?: string }) {
  return (
    <div className="stat">
      <div className="k">{accent && <i className="key" style={{ background: accent }} />}{k}</div>
      <div className="v" style={bad ? { color: 'var(--bad)' } : undefined}>{v}</div>
      {onSub
        ? <div className="s replay" role="button" tabIndex={0} title={subTitle} onClick={onSub} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSub(); } }}>{s}</div>
        : <div className="s">{s || ' '}</div>}
    </div>
  );
}
