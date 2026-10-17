import { potCost } from '../core/session';
import { fmtN } from '../core/util';
import { useCtrl } from './hooks';

export function PotionsTab() {
  const c = useCtrl();
  const set = c.settings, s = c.sess || c.lastFinished;
  if (!s) return <div className="card mut">Start a session to see HP/MP use.</div>;
  const pc = potCost(s, set);
  const amtFor = (type: 'hp' | 'mp') => (set.potBasis === 'used' ? s[type].used : s[type].rec);
  const edit = (i: number, f: 'amt' | 'price', v: number) => c.updateSettings({ pots: set.pots.map((p, j) => (j === i ? { ...p, [f]: Math.max(0, v || 0) } : p)) });

  return (
    <section>
      <div className="card">
        <h3>HP / MP this session</h3>
        <div className="tiles">
          <div className="tile"><div className="k">HP lost</div><div className="v" style={{ color: 'var(--hp)' }}>{fmtN(s.hp.used)}</div></div>
          <div className="tile"><div className="k">HP recovered (pots)</div><div className="v" style={{ color: 'var(--hp)' }}>{fmtN(s.hp.rec)}</div>
            <div className="s">{c.tracker ? `+${fmtN(c.tracker.hp.regen)} small regen ignored` : ''}</div></div>
          <div className="tile"><div className="k">MP spent</div><div className="v" style={{ color: 'var(--mp)' }}>{fmtN(s.mp.used)}</div></div>
          <div className="tile"><div className="k">MP recovered (pots)</div><div className="v" style={{ color: 'var(--mp)' }}>{fmtN(s.mp.rec)}</div>
            <div className="s">{c.tracker ? `+${fmtN(c.tracker.mp.regen)} small regen ignored` : ''}</div></div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <span className="mut">Count potions from:</span>
          <select value={set.potBasis} onChange={e => c.updateSettings({ potBasis: e.target.value as 'rec' | 'used' })}>
            <option value="rec">Recovered (jumps of pot size)</option>
            <option value="used">Consumed (all HP/MP lost)</option>
          </select>
        </div>
      </div>
      <div className="card">
        <h3>Potion conversion</h3>
        <table>
          <thead><tr><th>Main</th><th>Item</th><th className="n">Restores</th><th className="n">Price</th><th className="n">Count</th><th className="n">Cost</th></tr></thead>
          <tbody>
            {set.pots.map((p, i) => {
              const n = p.amt > 0 ? Math.ceil(amtFor(p.type) / p.amt) : 0, main = (p.type === 'hp' ? set.mainHp : set.mainMp) === p.id;
              return (
                <tr key={p.id}>
                  <td><input type="radio" name={'main' + p.type} checked={main} onChange={() => c.updateSettings(p.type === 'hp' ? { mainHp: p.id } : { mainMp: p.id })} /></td>
                  <td style={{ color: `var(--${p.type})` }}>{p.name}</td>
                  <td className="n"><input type="number" value={p.amt} style={{ width: 70 }} onChange={e => edit(i, 'amt', +e.target.value)} /> {p.type.toUpperCase()}</td>
                  <td className="n"><input type="number" value={p.price} style={{ width: 80 }} onChange={e => edit(i, 'price', +e.target.value)} /></td>
                  <td className="n">{fmtN(n)}</td><td className="n">{fmtN(n * p.price)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="mut small" style={{ marginTop: 8 }}>Amounts and prices are editable. The <b>Main</b> HP and MP pots are used for “Pot cost” and net mesos.</div>
        <div className="tiles" style={{ marginTop: 12 }}>
          <div className="tile"><div className="k">Total pot cost</div><div className="v">{fmtN(pc.total)}</div></div>
          <div className="tile"><div className="k">Mesos picked up</div><div className="v">{fmtN(s.mesos)}</div></div>
          <div className="tile"><div className="k">Net mesos</div><div className="v" style={{ color: s.mesos - pc.total >= 0 ? 'var(--ok)' : 'var(--bad)' }}>{fmtN(s.mesos - pc.total)}</div></div>
        </div>
      </div>
    </section>
  );
}
