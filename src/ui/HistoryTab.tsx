import { useMemo, useState } from 'react';
import { summaryText, type SavedSession } from '../core/session';
import * as store from '../core/storage';
import { fmtHM, fmtK, fmtN } from '../core/util';
import { DropTable } from './DropsTab';
import { toast, useCtrl } from './hooks';

/** History is only re-read from storage when a session is saved/imported/deleted (historyVersion changes). */
export function HistoryTab() {
  const c = useCtrl();
  const [, bump] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const v = c.historyVersion;
  const { all, chars } = useMemo(() => ({ all: store.loadSessions(), chars: store.loadChars() }), [v]);
  const refresh = () => { c.historyVersion++; bump(x => x + 1); };

  const names = [...new Set(all.map(s => s.char))];
  if (!names.length) return <div className="card mut">No sessions yet.</div>;
  const cur = sel && names.includes(sel) ? sel : names[names.length - 1];
  const list = all.filter(s => s.char === cur).sort((a, b) => b.start - a.start), ch = chars[cur] || {};
  const totExp = list.reduce((a, s) => a + s.exp, 0), totMs = list.reduce((a, s) => a + s.activeMs, 0), totMeso = list.reduce((a, s) => a + s.mesos, 0);

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
        </div>
      </div>
      {list.map(x => <SessionCard key={x.id} x={x} onDelete={() => { store.saveSessions(all.filter(s => s.id !== x.id)); refresh(); }} />)}
    </section>
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
            Pots: {Object.values(x.potDetail).map(d => `${d!.count} ${d!.name}`).join(', ') || '—'} = <b>{fmtN(x.potCost)}</b> mesos · net <b>{fmtN(x.mesos - x.potCost)}</b>
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
