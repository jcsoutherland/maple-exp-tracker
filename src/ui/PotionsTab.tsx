import { useState } from 'react';
import { HOTBAR_COLS, HOTBAR_ROWS } from '../core/config';
import { allPotions, potionByName, SHOP_PRICE_FACTOR, type Potion } from '../core/potions';
import { potCost } from '../core/session';
import { fmtN } from '../core/util';
import { useCtrl, useItemIcon } from './hooks';

/** drag payload: a potion name, plus the hotbar slot it came from when dragged off the hotbar */
const DND = 'application/x-maple-pot';
interface Drag { name: string; from?: number }

/** HP and MP recovery items. Potions placed on the hotbar are the ones counted, each separately. */
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
        Only potions on the hotbar are counted. Their slot counts are read off the screen, so each type is counted exactly and pickups
        never count. If a count can't be read for a moment, a sharp rise on the HP/MP gauge (at least the regen cutoff in Setup) goes to
        the hotbar potion whose restore amount fits it best. Restore amounts come from the item data; shop price
        is {SHOP_PRICE_FACTOR}× the item's NPC sell value.
      </div>
    </section>
  );
}

/** The in-game quickslot (4×3): drop potions where they sit in the game, so each one's use is counted separately. */
function Hotbar() {
  const c = useCtrl();
  const bar = c.settings.hotbar;
  const [over, setOver] = useState<number | null>(null);
  // while tracking, each potion slot shows the count read off the screen; none readable = the Quickslot box is off
  const live = !!c.sess && !c.sess.paused && c.capture.ready;
  const filled = bar.map((n, i) => (n && potionByName(n) ? i : -1)).filter(i => i >= 0);
  const unread = live && c.rates().el > 15000 && filled.length > 0 && filled.every(i => c.slotCount(i) == null);
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
        {live && <div className="mut small" style={{ marginTop: 8 }}>The number under each potion is the count being read from your screen right now.</div>}
        {unread && <div className="note warnnote"><span>Can't read the potion counts on your quickslot. Open <b>Setup</b> and line the <b>Quickslot</b> box up with your in-game quickslot.</span></div>}
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
              {p ? <><PotIcon p={p} /><button className="hx" title="Remove" onClick={() => set(i, null)}>×</button>
                {live && <span className={'hcount' + (c.slotCount(i) == null ? ' unread' : '')} title={c.slotCount(i) == null ? 'Count not readable yet' : 'Count read from your screen'}>{c.slotCount(i) ?? '?'}</span>}</> : null}
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
  // the list is a palette to drag onto the hotbar; only potions on the hotbar are counted
  const key = kind === 'hp' ? 'hpOrder' : 'mpOrder';
  const order = c.settings[key];
  const setOrder = (o: string[]) => c.updateSettings({ [key]: o });
  const others = allPotions(kind).filter(p => !order.includes(p.name));

  return (
    <div className="card">
      <h3 style={{ color: `var(--${kind})` }}>{kind === 'hp' ? '❤ HP recovery' : '💧 MP recovery'}</h3>
      <div className="potlist">
        {order.map(name => {
          const p = potionByName(name);
          if (!p) return null;
          const used = pc?.items.find(u => u.name === p.name && u.kind === kind), onBar = c.settings.hotbar.includes(p.name);
          return (
            <div key={name} draggable className={'potrow' + (onBar ? ' active' : '')} title="Drag onto the hotbar to count it"
              onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData(DND, JSON.stringify({ name: p.name } satisfies Drag)); }}>
              <span className="grip" aria-hidden>⋮⋮</span>
              <PotIcon p={p} />
              <div className="potname">
                <b>{p.name}</b>
                <span className="mut small">{restoreText(p, kind)} · {fmtN(p.shopPrice)} mesos</span>
              </div>
              {onBar && <span className="badge" title="On the hotbar, so it's counted">On hotbar</span>}
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
