import { useState } from 'react';
import { allPotions, potionByName, potionsUsed, restoreOf, SHOP_PRICE_FACTOR, type Potion } from '../core/potions';
import { potCost } from '../core/session';
import { fmtN } from '../core/util';
import { useCtrl, useItemIcon } from './hooks';

/** HP and MP recovery items. Drag one to the top to make it Active; counts are potions actually consumed. */
export function PotionsTab() {
  const c = useCtrl();
  const s = c.sess || c.lastFinished;
  const pc = s ? potCost(s, c.settings) : null;
  return (
    <section>
      <div className="tiles" style={{ marginBottom: 14 }}>
        <div className="tile"><div className="k">HP potions used</div><div className="v" style={{ color: 'var(--hp)' }}>{fmtN(pc?.detail.hp?.count ?? 0)}</div><div className="s">{pc?.detail.hp?.name ?? ''}</div></div>
        <div className="tile"><div className="k">MP potions used</div><div className="v" style={{ color: 'var(--mp)' }}>{fmtN(pc?.detail.mp?.count ?? 0)}</div><div className="s">{pc?.detail.mp?.name ?? ''}</div></div>
        <div className="tile"><div className="k">Potion cost</div><div className="v">{fmtN(pc?.total ?? 0)}</div><div className="s">mesos at shop price</div></div>
        <div className="tile"><div className="k">Net mesos</div><div className="v" style={{ color: s && pc && s.mesos - pc.total < 0 ? 'var(--bad)' : 'var(--ok)' }}>{s && pc ? fmtN(s.mesos - pc.total) : '0'}</div><div className="s">picked up − potions</div></div>
      </div>
      <div className="grid2">
        <PotionSection kind="hp" />
        <PotionSection kind="mp" />
      </div>
      <div className="mut small" style={{ marginTop: 4 }}>
        The HP/MP gauges are checked 10× a second: each sharp rise of at least the regen cutoff (Setup) is a potion, even while you're
        being hit; a rise worth two potions counts as two.
        Restore amounts come from the item data; shop price is {SHOP_PRICE_FACTOR}× the item's NPC sell value.
      </div>
    </section>
  );
}

function PotionSection({ kind }: { kind: 'hp' | 'mp' }) {
  const c = useCtrl();
  const s = c.sess || c.lastFinished;
  const key = kind === 'hp' ? 'hpOrder' : 'mpOrder';
  const order = c.settings[key];
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const setOrder = (o: string[]) => c.updateSettings({ [key]: o });
  const move = (from: number, to: number) => { const o = [...order]; const [x] = o.splice(from, 1); o.splice(to, 0, x); setOrder(o); };
  const others = allPotions(kind).filter(p => !order.includes(p.name));
  const flow = s?.[kind];

  return (
    <div className="card">
      <h3 style={{ color: `var(--${kind})` }}>{kind === 'hp' ? '❤ HP recovery' : '💧 MP recovery'}</h3>
      <div className="potlist">
        {order.map((name, i) => {
          const p = potionByName(name);
          if (!p) return null;
          const r = restoreOf(p, kind, flow?.max ?? null), used = i === 0 && flow ? potionsUsed(flow.jumps ?? [], r) : null;
          return (
            <div key={name} draggable
              className={'potrow' + (i === 0 ? ' active' : '') + (over === i && drag !== i ? ' over' : '')}
              onDragStart={e => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={e => { e.preventDefault(); setOver(i); }}
              onDragLeave={() => setOver(o => (o === i ? null : o))}
              onDrop={e => { e.preventDefault(); if (drag != null && drag !== i) move(drag, i); setDrag(null); setOver(null); }}
              onDragEnd={() => { setDrag(null); setOver(null); }}>
              <span className="grip" aria-hidden>⋮⋮</span>
              <PotIcon p={p} />
              <div className="potname">
                <b>{p.name}</b>
                <span className="mut small">{restoreText(p, kind)} · {fmtN(p.shopPrice)} mesos</span>
              </div>
              {i === 0 ? <span className="badge">Active</span> : <button className="sm" title="Make active" onClick={() => move(i, 0)}>▲ Use</button>}
              {used != null && <div className="potused"><b>×{fmtN(used)}</b><span className="mut small">{fmtN(used * p.shopPrice)} mesos</span></div>}
              {order.length > 1 && <button className="sm x" title="Remove from list" onClick={() => setOrder(order.filter(n => n !== name))}>×</button>}
            </div>
          );
        })}
      </div>
      {others.length > 0 && (
        <select className="addpot" value="" onChange={e => e.target.value && setOrder([...order, e.target.value])}>
          <option value="">+ Add a {kind.toUpperCase()} item…</option>
          {others.map(p => <option key={p.name} value={p.name}>{p.name} — {restoreText(p, kind)}</option>)}
        </select>
      )}
    </div>
  );
}

const restoreText = (p: Potion, kind: 'hp' | 'mp') => {
  const flat = kind === 'hp' ? p.hp : p.mp, pct = kind === 'hp' ? p.hpPct : p.mpPct;
  const both = p.hp && p.mp ? ` (+${kind === 'hp' ? p.mp + ' MP' : p.hp + ' HP'})` : '';
  return (flat ? `${flat} ${kind.toUpperCase()}` : `${Math.round(pct * 100)}% ${kind.toUpperCase()}`) + both;
};

function PotIcon({ p }: { p: Potion }) {
  const url = useItemIcon(p.id);
  return <span className="ic-wrap">{url && <img className="ic" src={url} alt="" />}</span>;
}
