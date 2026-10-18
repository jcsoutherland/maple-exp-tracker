import { MAX_LEVEL } from '../core/config';
import { mobByName, mobsOnMap, type MobRec } from '../core/data/osms';
import { expToNext, expToReach } from '../core/exptable';
import * as store from '../core/storage';
import { fmtHM, fmtN } from '../core/util';
import { useCtrl } from './hooks';
import { NumberInput } from './NumberInput';

/** The rate to plan with: the last 10 minutes when there is one, else the whole session. */
function useRate() {
  const c = useCtrl(), { hr, r10 } = c.rates();
  return r10 || hr || null;
}

/** Level, EXP into it, and the saved target level for the character on screen. */
function useGoal() {
  const c = useCtrl(), s = c.sess ?? c.lastFinished, id = c.identity;
  const level = s?.level ?? id.level ?? null, exp = c.sess ? c.tracker?.exp ?? 0 : 0;
  const saved = id.name ? store.loadChars()[id.name]?.goal : undefined;
  const goal = level ? Math.min(MAX_LEVEL, Math.max(level + 1, saved ?? level + 1)) : null;
  const remaining = level && goal ? expToReach(level, exp, goal) : null;
  const next = level ? (expToNext(level) ?? 0) - exp : null;
  return { level, exp, goal, remaining, next };
}

/** Pick a target level: progress toward it, EXP still to go and when you'll get there at the current rate. */
export function GoalPanel() {
  const c = useCtrl(), rate = useRate(), { level, goal, remaining } = useGoal();
  const total = level && goal ? expToReach(level, 0, goal) : null;
  const pct = total && remaining != null ? Math.max(0, Math.min(100, (1 - remaining / total) * 100)) : 0;
  const setGoal = (v: number) => {
    const name = c.identity.name;
    if (!name || !level) return;
    const ch = store.loadChars();
    ch[name] = { ...ch[name], goal: Math.min(MAX_LEVEL, Math.max(level + 1, Math.round(v) || level + 1)) };
    store.saveChars(ch);
    c.notify();
  };
  return (
    <div className="xpanel goal">
      <div className="xhead">
        <span>Level goal</span>
        <label className="goalin">Target Lv <NumberInput width={52} min={(level ?? 0) + 1} max={MAX_LEVEL} value={goal} disabled={!level} onChange={setGoal} /></label>
      </div>
      {level && goal ? <>
        <div className="goalbar"><div style={{ width: pct + '%' }} /><span>Lv {level} → {goal} · {pct.toFixed(1)}%</span></div>
        <div className="goalnums">
          <div><span className="mut small">EXP to go</span><b>{remaining != null ? fmtN(remaining) : '—'}</b></div>
          <div><span className="mut small">Levels</span><b>{goal - level}</b></div>
          <div><span className="mut small">ETA</span><b>{remaining && rate ? fmtHM(remaining / rate * 3.6e6) : '—'}</b></div>
        </div>
        {!rate && <div className="mut small">The ETA appears after about a minute of EXP.</div>}
      </> : <div className="mut small">Set your level (top of the page) to plan a goal.</div>}
    </div>
  );
}

/** The monster you're fighting: the latest etc drop's monster, else the strongest regular monster on the map. */
function currentMob(c: ReturnType<typeof useCtrl>): MobRec | null {
  const s = c.sess ?? c.lastFinished;
  const latest = Object.entries(s?.mobs ?? {}).sort((a, b) => b[1].last - a[1].last)[0]?.[0];
  return (latest && mobByName(latest)) || mobsOnMap(c.tracker?.mapCur ?? null).filter(m => !m.boss).sort((a, b) => b.exp - a.exp)[0] || null;
}

/** Rough kill counts from EXP ÷ the monster's base EXP: this session, per hour, and to the next level / the goal. */
export function KillsPanel() {
  const c = useCtrl(), s = c.sess ?? c.lastFinished, rate = useRate(), { goal, remaining, next } = useGoal();
  const m = currentMob(c);
  const mapExp = s ? (c.tracker?.mapCur && s.maps[c.tracker.mapCur]) || s.exp : 0;
  const k = (exp: number | null) => (m && exp != null ? fmtN(Math.ceil(exp / m.exp)) : '—');
  return (
    <div className="xpanel kills">
      <div className="xhead"><span>Kills (estimate)</span>{m && <span className="mut small">{m.name} · {fmtN(m.exp)} EXP</span>}</div>
      {m ? <>
        <div className="goalnums">
          <div><span className="mut small">This map</span><b>≈{k(mapExp)}</b></div>
          <div><span className="mut small">Per hour</span><b>≈{rate ? k(rate) : '—'}</b></div>
          <div><span className="mut small">To next Lv</span><b>≈{k(next)}</b></div>
          <div><span className="mut small">To Lv {goal ?? '?'}</span><b>≈{k(remaining)}</b></div>
        </div>
        <div className="mut small">From {m.name}'s base EXP. In a party each kill gives you less, so the real count is higher.</div>
      </> : <div className="mut small">Shows up once the monster is known (an etc drop, or a map in the monster data).</div>}
    </div>
  );
}
