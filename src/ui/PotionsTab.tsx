import { useState } from 'react';
import { HOTBAR_COLS, HOTBAR_ROWS } from '../core/config';
import { allPotions, potionByName, SHOP_PRICE_FACTOR, type Potion } from '../core/potions';
import { potCost } from '../core/session';
import { fmtN } from '../core/util';
import { useCtrl, useItemIcon } from './hooks';

/** drag payload: a potion name, plus the hotbar slot it came from when dragged off the hotbar */
const DND = 'application/x-maple-pot';
interface Drag { name: string; from?: number }

/** HP and MP recovery items. Drag one to the top to make it Active; drag them onto the hotbar to count each separately. */
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
      <Hotbar />
      <div className="grid2">
        <PotionSection kind="hp" />
        <PotionSection kind="mp" />
      </div>
      <div className="mut small" style={{ marginTop: 4 }}>
        The HP/MP gauges are checked 10× a second: each sharp rise of at least the regen cutoff (Setup) is a potion, even while you're
        being hit; a rise worth two potions counts as two. It's credited to the hotbar potion whose count changed just before, otherwise
        to the Active one. Restore amounts come from the item data; shop price is {SHOP_PRICE_FACTOR}× the item's NPC sell value.
      </div>
    </section>
  );
}

/** The in-game quickslot (4×3): drop potions where they sit in the game, so each one's use is counted separately. */
function Hotbar() {
  const c = useCtrl();
  const bar = c.settings.hotbar;
  const [over, setOver] = useState<number | null>(null);
  const set = (i: number, name: string | null, from?: number) => {
    const b = [...bar];
    if (from != null && from !== i) b[from] = b[i]; // swap when moved between slots
    b[i] = name;
    c.updateSettings({ hotbar: b });
  };
  return (
    <div className="card hotbar-card">
      <div>
        <h3>Hotbar</h3>
        <div className="mut small" style={{ maxWidth: 360 }}>
          Drag potions from the lists below onto the slots they use in your game's quickslot. Each one's count is then watched
          (no OCR), so every potion type is counted separately and pickups never count. Line up the <b>Quickslot</b> box once in Setup.
        </div>
      </div>
      <div className="hotbar" style={{ gridTemplateColumns: `repeat(${HOTBAR_COLS}, 1fr)` }}>
        {Array.from({ length: HOTBAR_COLS * HOTBAR_ROWS }, (_, i) => {
          const name = bar[i] ?? null, p = name ? potionByName(name) : null;
          return (
            <div key={i} className={'hslot' + (over === i ? ' over' : '') + (p ? ' full' : '')}
              draggable={!!p}
              onDragStart={e => { if (name) e.dataTransfer.setData(DND, JSON.stringify({ name, from: i } satisfies Drag)); }}
              onDragOver={e => { if (e.dataTransfer.types.includes(DND)) { e.preventDefault(); setOver(i); } }}
              onDragLeave={() => setOver(o => (o === i ? null : o))}
              onDrop={e => { e.preventDefault(); setOver(null); const d = JSON.parse(e.dataTransfer.getData(DND) || 'null') as Drag | null; if (d) set(i, d.name, d.from); }}
              title={p ? `${p.name} (drag to move)` : 'Drop a potion here'}>
              {p ? <><PotIcon p={p} /><button className="hx" title="Remove" onClick={() => set(i, null)}>×</button></> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PotionSection({ kind }: { kind: 'hp' | 'mp' }) {
  const c = useCtrl();
  const s = c.sess || c.lastFinished;
  const pc = s ? potCost(s, c.settings) : null;
  const key = kind === 'hp' ? 'hpOrder' : 'mpOrder';
  const order = c.settings[key];
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const setOrder = (o: string[]) => c.updateSettings({ [key]: o });
  const move = (from: number, to: number) => { const o = [...order]; const [x] = o.splice(from, 1); o.splice(to, 0, x); setOrder(o); };
  const others = allPotions(kind).filter(p => !order.includes(p.name));

  return (
    <div className="card">
      <h3 style={{ color: `var(--${kind})` }}>{kind === 'hp' ? '❤ HP recovery' : '💧 MP recovery'}</h3>
      <div className="potlist">
        {order.map((name, i) => {
          const p = potionByName(name);
          if (!p) return null;
          const used = pc?.items.find(u => u.name === p.name && u.kind === kind), onBar = c.settings.hotbar.includes(p.name);
          return (
            <div key={name} draggable
              className={'potrow' + (i === 0 ? ' active' : '') + (over === i && drag !== i ? ' over' : '')}
              onDragStart={e => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(DND, JSON.stringify({ name: p.name } satisfies Drag)); }}
              onDragOver={e => { if (drag != null) { e.preventDefault(); setOver(i); } }}
              onDragLeave={() => setOver(o => (o === i ? null : o))}
              onDrop={e => { e.preventDefault(); if (drag != null && drag !== i) move(drag, i); setDrag(null); setOver(null); }}
              onDragEnd={() => { setDrag(null); setOver(null); }}>
              <span className="grip" aria-hidden>⋮⋮</span>
              <PotIcon p={p} />
              <div className="potname">
                <b>{p.name}</b>
                <span className="mut small">{restoreText(p, kind)} · {fmtN(p.shopPrice)} mesos{onBar ? ' · on hotbar' : ''}</span>
              </div>
              {i === 0 ? <span className="badge" title="Potions not tied to a hotbar slot are counted as this one">Active</span> : <button className="sm" title="Make active" onClick={() => move(i, 0)}>▲ Use</button>}
              {used && <div className="potused"><b>×{fmtN(used.count)}</b><span className="mut small">{fmtN(used.cost)} mesos</span></div>}
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

export function PotIcon({ p }: { p: Pick<Potion, 'id'> }) {
  const url = useItemIcon(p.id);
  return <span className="ic-wrap">{url && <img className="ic" src={url} alt="" />}</span>;
}
