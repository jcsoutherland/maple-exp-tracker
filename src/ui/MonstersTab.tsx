import { useEffect, useMemo, useState } from 'react';
import { mobByName, mobImage } from '../core/data/osms';
import { clearChar, totals, type MobTotal } from '../core/leaderboard';
import * as store from '../core/storage';
import { fmtHM, fmtN } from '../core/util';
import { toast, useCtrl } from './hooks';

/** monsters show up once they have this many kills */
const MIN_KILLS = 50;
type SortKey = 'kills' | 'level' | 'exp' | 'ms';
const COLUMNS: [SortKey, string][] = [['level', 'Lv'], ['kills', '≈ Kills'], ['exp', 'EXP'], ['ms', 'Time']];

const baseExp = (name: string) => mobByName(name)?.exp ?? null;
const levelOf = (name: string) => mobByName(name)?.level ?? 0;
const day = (t: number) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

/** The Killcount tab, a monster leaderboard: each character's estimated kills per monster over all their sessions. */
export function MonstersTab() {
  const c = useCtrl();
  const [sel, setSel] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'kills', desc: true });
  const [clearArmed, setClearArmed] = useState(false);
  const board = useMemo(() => store.loadKills(), [c.historyVersion]);
  const names = Object.keys(board).filter(n => Object.keys(board[n].sessions).length || n === c.identity.name);
  const cur = sel && names.includes(sel) ? sel : names.includes(c.identity.name) ? c.identity.name : names[0];

  // ranked by kills; the rank stays with the monster when another column sorts the list
  const ranked = useMemo(() => totals(board[cur], baseExp).filter(t => t.kills >= MIN_KILLS), [board, cur]);
  const value = (t: MobTotal) => (sort.key === 'level' ? levelOf(t.name) : t[sort.key]);
  const rows = [...ranked].sort((a, b) => (sort.desc ? value(b) - value(a) : value(a) - value(b)));
  const sortBy = (key: SortKey) => setSort(s => ({ key, desc: s.key === key ? !s.desc : true }));

  const clear = () => {
    if (!clearArmed) { setClearArmed(true); setTimeout(() => setClearArmed(false), 4000); return; }
    store.saveKills(clearChar(store.loadKills(), cur));
    setClearArmed(false); c.historyVersion++; c.notify();
    toast(`Cleared ${cur}'s monster leaderboard`);
  };

  return (
    <section>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="ctabs">{names.map(n => <button key={n} className={n === cur ? 'act' : ''} onClick={() => setSel(n)}>{n}</button>)}</div>
        <span className="sp" />
        {cur && <button className={clearArmed ? 'danger' : ''} onClick={clear}>{clearArmed ? 'Click again to clear' : 'Clear leaderboard'}</button>}
      </div>
      <div className="card">
        <div className="mut small" style={{ marginBottom: 10 }}>
          Kills are an estimate: EXP earned while it's clear which monster you were fighting, divided by that monster's EXP, and
          never fewer than the etc drops it gave you. In a party each kill gives you less EXP, so the count comes out lower.
          Monsters appear once they reach {MIN_KILLS} kills. Clearing History doesn't touch this leaderboard.
        </div>
        {!rows.length ? <div className="mut">No monster has {MIN_KILLS} kills yet. Each session's kills are added when it ends.</div> : (
          <table className="mons">
            <thead><tr>
              <th className="n">#</th><th>Monster</th>
              {COLUMNS.map(([key, label]) => (
                <th key={key} className={'n sortable' + (sort.key === key ? ' on' : '')} onClick={() => sortBy(key)} title="Sort">
                  {label}{sort.key === key ? (sort.desc ? ' ▼' : ' ▲') : ''}
                </th>
              ))}
              <th>Top map</th><th>First hunted</th><th>Last hunted</th>
            </tr></thead>
            <tbody>
              {rows.map(t => (
                <tr key={t.name}>
                  <td className="n mut">{ranked.indexOf(t) + 1}</td>
                  <td><span className="mon"><MobPic name={t.name} />{t.name}</span></td>
                  <td className="n">{levelOf(t.name) || '—'}</td>
                  <td className="n"><b>≈{fmtN(t.kills)}</b></td>
                  <td className="n">{fmtN(t.exp)}</td>
                  <td className="n">{fmtHM(t.ms)}</td>
                  <td>{t.topMap ?? '—'}</td>
                  <td>{day(t.first)}</td>
                  <td>{day(t.last)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

/** The monster's picture (from the mirror, then this device's cache). */
function MobPic({ name }: { name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const m = mobByName(name);
    if (m) mobImage(m).then(u => { if (live) setUrl(u); }).catch(e => console.warn('monster picture unavailable', name, e));
    return () => { live = false; };
  }, [name]);
  return <span className="monpic">{url && <img src={url} alt="" />}</span>;
}
