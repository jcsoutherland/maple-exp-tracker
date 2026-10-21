import { useMemo, useState } from 'react';
import { summaryText, type SavedSession } from '../core/session';
import * as store from '../core/storage';
import { fmtHM, fmtK, fmtN } from '../core/util';
import { DropTable } from './DropsTab';
import { toast, useCtrl } from './hooks';
import { appSeen } from '../app/desktopLink';

/** For players with the desktop overlay: sessions it tracked come in when it's open alongside this page. */
function SyncNote() {
  if (!appSeen()) return null;
  return (
    <div className="note" style={{ marginBottom: 12 }}>
      <span>Using the desktop overlay and don't see a session? Open the overlay while this page is open and it syncs by itself.</span>
    </div>
  );
}

/** History is only re-read from storage when a session is saved/imported/deleted (historyVersion changes). */
export function HistoryTab() {
  const c = useCtrl();
  const [, bump] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const v = c.historyVersion;
  const { all, chars } = useMemo(() => ({ all: store.loadSessions(), chars: store.loadChars() }), [v]);
  const refresh = () => { c.historyVersion++; bump(x => x + 1); };

  const [clearArmed, setClearArmed] = useState(false);
  const names = [...new Set(all.map(s => s.char))];
  if (!names.length) return <section><SyncNote /><div className="card mut">No sessions yet.</div></section>;
  const cur = sel && names.includes(sel) ? sel : names[names.length - 1];
  const list = all.filter(s => s.char === cur).sort((a, b) => b.start - a.start), ch = chars[cur] || {};
  const totExp = list.reduce((a, s) => a + s.exp, 0), totMs = list.reduce((a, s) => a + s.activeMs, 0), totMeso = list.reduce((a, s) => a + s.mesos, 0);
  const recent = list.filter(s => !s.archived), days = byDay(list.filter(s => s.archived));
  const archiveAll = () => { store.saveSessions(all.map(s => (s.char === cur ? { ...s, archived: true } : s))); refresh(); toast(`Archived ${recent.length} session${recent.length > 1 ? 's' : ''}`); };
  const clearAll = () => {
    if (!clearArmed) { setClearArmed(true); setTimeout(() => setClearArmed(false), 4000); return; }
    store.saveSessions(all.filter(s => s.char !== cur)); setClearArmed(false); setSel(null); refresh(); toast(`Cleared ${cur}'s history`);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ sessions: all, chars }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `maple-exp-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  const importJson = async (f: File) => {
    try {
      const d = JSON.parse(await f.text()) as { sessions?: SavedSession[]; chars?: ReturnType<typeof store.loadChars> };
      const ids = new Set(all.map(s => s.id));
      store.saveSessions([...all, ...(d.sessions || []).filter(s => !ids.has(s.id))]);
      store.saveChars({ ...(d.chars || {}), ...chars });
      refresh(); toast('Imported');
    } catch { toast('Import failed'); }
  };

  return (
    <section>
      <SyncNote />
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="ctabs">{names.map(n => <button key={n} className={n === cur ? 'act' : ''} onClick={() => setSel(n)}>{n}</button>)}</div>
        <span className="sp" />
        <button onClick={exportJson}>Export JSON</button>
        <label className="btnlike"><button type="button" onClick={e => (e.currentTarget.nextElementSibling as HTMLInputElement).click()}>Import JSON</button>
          <input type="file" accept=".json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ''; }} /></label>
      </div>
      <div className="card">
        <div className="charhead">
          <div className="snap">{ch.thumb ? <img className="thumb" src={ch.thumb} alt="" /> : <span className="mut small" style={{ margin: 'auto' }}>no look yet</span>}</div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{cur}</div>
            <div className="mut">{ch.cls || list[0].cls} · Lv {ch.level ?? list[0].level ?? '?'}</div>
            <div className="small" style={{ marginTop: 6 }}>{list.length} sessions · {fmtHM(totMs)} · {fmtN(totExp)} EXP · avg {fmtN(totMs ? totExp / (totMs / 3.6e6) : 0)} EXP/hr · {fmtN(totMeso)} mesos</div>
          </div>
          <span className="sp" />
          <div className="row" style={{ alignSelf: 'flex-start' }}>
            <button disabled={!recent.length} onClick={archiveAll} title="Move these sessions into the archive, grouped by day">Archive sessions</button>
            <button className="danger" onClick={clearAll} title={`Delete all of ${cur}'s sessions`}>{clearArmed ? 'Click again to delete all' : 'Clear history'}</button>
          </div>
        </div>
      </div>
      {recent.map(x => <SessionCard key={x.id} x={x} onDelete={() => { store.saveSessions(all.filter(s => s.id !== x.id)); refresh(); }} />)}
      {!recent.length && <div className="mut small" style={{ margin: '10px 2px' }}>No new sessions since the last archive.</div>}
      {/* the archive stays folded away until you open it */}
      {days.length > 0 && (
        <details className="archive">
          <summary>
            <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
            <b>Archive</b>
            <span className="mut small">{days.length} day{days.length > 1 ? 's' : ''} · {list.length - recent.length} session{list.length - recent.length > 1 ? 's' : ''}</span>
          </summary>
          {days.map(d => <DayCard key={d.key} d={d} onDelete={id => { store.saveSessions(all.filter(s => s.id !== id)); refresh(); }} />)}
        </details>
      )}
    </section>
  );
}

interface Day { key: string; label: string; list: SavedSession[] }
/** Sessions grouped by the local day they started on, newest day first. */
function byDay(list: SavedSession[]): Day[] {
  const m = new Map<string, SavedSession[]>();
  for (const s of list) {
    const d = new Date(s.start), key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    (m.get(key) ?? m.set(key, []).get(key)!).push(s);
  }
  return [...m].sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, l]) => ({ key, label: new Date(l[0].start).toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }), list: l.sort((a, b) => b.start - a.start) }));
}

/** One archived day: its totals in the summary line, the sessions inside. */
function DayCard({ d, onDelete }: { d: Day; onDelete: (id: number) => void }) {
  const l = d.list, ms = l.reduce((a, s) => a + s.activeMs, 0), exp = l.reduce((a, s) => a + s.exp, 0), mesos = l.reduce((a, s) => a + s.mesos, 0);
  const pots = l.reduce((a, s) => a + s.potCost, 0), ups = l.reduce((a, s) => a + s.levelUps, 0), lost = l.reduce((a, s) => a + s.expLost, 0);
  const lv0 = Math.min(...l.map(s => s.levelStart ?? Infinity)), lv1 = Math.max(...l.map(s => s.level ?? -Infinity));
  const maps = new Map<string, number>();
  for (const s of l) for (const [k, v] of Object.entries(s.maps)) maps.set(k, (maps.get(k) || 0) + v);
  const top = [...maps].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return (
    <details className="sess card day">
      <summary>
        <b>{d.label}</b>
        <span className="mut">{l.length} session{l.length > 1 ? 's' : ''} · {fmtHM(ms)}</span>
        <span>{isFinite(lv0) ? `Lv ${lv0}${isFinite(lv1) && lv1 !== lv0 ? '→' + lv1 : ''}` : ''}{ups ? ` (${ups} level-up${ups > 1 ? 's' : ''})` : ''}</span>
        <span>{fmtN(exp)} EXP</span><span style={{ color: 'var(--exp)' }}>{fmtK(ms > 60000 ? exp / (ms / 3.6e6) : 0)}/hr</span>
        <span style={{ color: '#f5c542' }}>{fmtN(mesos)} mesos</span>
        {pots > 0 && <span className="mut">pots {fmtN(pots)}</span>}
        {lost > 0 && <span style={{ color: 'var(--bad)' }}>-{fmtN(lost)} EXP lost</span>}
      </summary>
      {top.length > 0 && <div className="small mut" style={{ marginTop: 8 }}>Top maps: {top.map(([k, v]) => `${k} ${fmtN(v)}`).join(' · ')}</div>}
      {l.map(x => <SessionCard key={x.id} x={x} onDelete={() => onDelete(x.id)} />)}
    </details>
  );
}

function SessionCard({ x, onDelete }: { x: SavedSession; onDelete: () => void }) {
  const [armed, setArmed] = useState(false);
  const hr = x.activeMs > 60000 ? x.exp / (x.activeMs / 3.6e6) : 0;
  return (
    <details className="sess card">
      <summary>
        <b>{new Date(x.start).toLocaleDateString()} {new Date(x.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>
        <span>{x.cls || '?'}</span><span>Lv {x.levelStart ?? '?'}{x.level && x.level !== x.levelStart ? '→' + x.level : ''}</span>
        <span>{fmtN(x.exp)} EXP</span><span style={{ color: 'var(--exp)' }}>{fmtK(hr)}/hr</span>
        <span className="mut">{fmtHM(x.activeMs)}</span><span style={{ color: '#f5c542' }}>{fmtN(x.mesos)} mesos</span>
        {x.expLost > 0 && <span style={{ color: 'var(--bad)' }}>-{fmtN(x.expLost)} EXP lost</span>}
      </summary>
      <div className="grid2" style={{ marginTop: 10 }}>
        <div>
          <table>
            <thead><tr><th>Map (≥1k EXP)</th><th className="n">EXP</th></tr></thead>
            <tbody>{Object.keys(x.maps).length ? Object.entries(x.maps).sort((a, b) => b[1] - a[1]).map(([k, v]) => <tr key={k}><td>{k}</td><td className="n">{fmtN(v)}</td></tr>)
              : <tr><td className="mut" colSpan={2}>none</td></tr>}</tbody>
          </table>
          <div className="small" style={{ marginTop: 8 }}>
            HP lost {fmtN(x.hp.used)} · MP spent {fmtN(x.mp.used)}<br />
            Pots: {(x.potItems ?? Object.values(x.potDetail)).filter(d => d?.count).map(d => `${d!.count} ${d!.name}`).join(', ') || '—'} = <b>{fmtN(x.potCost)}</b> mesos · net <b>{fmtN(x.mesos - x.potCost)}</b>
            {x.deaths > 0 && <><br /><span style={{ color: 'var(--bad)' }}>EXP lost: -{fmtN(x.expLost)}</span> ({x.deaths} death{x.deaths > 1 ? 's' : ''}) · net {fmtN(x.exp - x.expLost)} EXP</>}
          </div>
        </div>
        <div><DropTable drops={x.drops} compact /></div>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => navigator.clipboard.writeText(summaryText(x)).then(() => toast('Copied'))}>Copy summary</button>
        <button className="danger" onClick={() => (armed ? onDelete() : setArmed(true))}>{armed ? 'Click again to delete' : 'Delete'}</button>
      </div>
    </details>
  );
}
