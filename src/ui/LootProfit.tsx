import { itemByName } from '../core/data/osms';
import { elapsed, potCost } from '../core/session';
import { fmtK, fmtN } from '../core/util';
import { useCtrl, useItemIcon } from './hooks';

/** One item's money: picked up (at NPC value) minus used (potions at shop price), netted into one value. */
interface Entry { key: string; name: string; got: number; used: number; value: number; id?: number; meso?: boolean }

/**
 * Loot & profit for the session: mesos picked up, drops at their NPC sell value, potions at shop price, and the net
 * (also per hour), plus the ten biggest money makers and costs.
 */
export function LootProfit() {
  const c = useCtrl(), s = c.sess ?? c.lastFinished;
  if (!s) return null;
  const pc = potCost(s, c.settings);
  const drops: Entry[] = Object.entries(s.drops).map(([name, d]) => {
    const rec = itemByName(name);
    return { key: 'd' + name, name, got: d.qty, used: 0, value: (rec?.price ?? 0) * d.qty, id: d.id ?? rec?.id };
  });
  const loot = drops.reduce((a, e) => a + e.value, 0), net = s.mesos + loot - pc.total;
  const ms = c.sess ? elapsed(c.sess) : s.activeMs, hrs = ms / 3.6e6;
  // an item both picked up and used (potions drop too) is one row with its net value
  const byName = new Map<string, Entry>(drops.map(e => [e.name, e]));
  for (const i of pc.items) {
    const e = byName.get(i.name) ?? byName.set(i.name, { key: 'd' + i.name, name: i.name, got: 0, used: 0, value: 0, id: i.id }).get(i.name)!;
    e.used += i.count; e.value -= i.cost;
  }
  const all: Entry[] = [
    ...(s.mesos ? [{ key: 'meso', name: 'Mesos picked up', got: 0, used: 0, value: s.mesos, meso: true }] : []),
    ...byName.values(),
  ];
  const top = all.filter(e => e.value).sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 10);
  const big = Math.max(1, ...top.map(e => Math.abs(e.value)));
  return (
    <div className="card loot">
      <h3>Loot &amp; profit</h3>
      <div className="lootgrid">
        <div className="lootsum">
          <Line k="Mesos picked up" v={s.mesos} />
          <Line k="Drops (NPC value)" v={loot} />
          <Line k="Potions" v={-pc.total} />
          <div className="lootnet"><span>Net</span><b className={net < 0 ? 'neg' : 'pos'}>{net < 0 ? '−' : '+'}{fmtN(Math.abs(net))}</b></div>
          <div className="mut small">{hrs > 1 / 60 ? `${net < 0 ? '−' : '+'}${fmtK(Math.abs(net / hrs))} mesos / hr` : 'per hour after a minute'}</div>
        </div>
        <div className="lootlist">
          <div className="mut small">Biggest earners and costs</div>
          {top.length ? top.map(e => <LootRow key={e.key} e={e} big={big} />) : <div className="mut small">Nothing yet.</div>}
        </div>
      </div>
      <div className="mut small" style={{ marginTop: 8 }}>Drops are valued at what an NPC shop pays; player prices are usually higher (links on the Drops tab).</div>
    </div>
  );
}

/** "×60" when only picked up, "×5 used" when only used, "+6 · −5 used" when both. */
const qtyText = (e: Entry) => (e.meso ? '' : e.got && e.used ? ` +${fmtN(e.got)} · −${fmtN(e.used)} used` : e.used ? ` ×${fmtN(e.used)} used` : ` ×${fmtN(e.got)}`);

function Line({ k, v }: { k: string; v: number }) {
  return <div className="lootline"><span className="mut">{k}</span><b className={v < 0 ? 'neg' : ''}>{v < 0 ? '−' : ''}{fmtN(Math.abs(v))}</b></div>;
}

function LootRow({ e, big }: { e: Entry; big: number }) {
  const icon = useItemIcon(e.id);
  return (
    <div className="lootrow">
      <span className="ic-wrap">{e.meso ? <span className="coin">●</span> : icon && <img className="ic" src={icon} alt="" />}</span>
      <span className="ln">{e.name}<span className="mut">{qtyText(e)}</span></span>
      <span className="lbar"><i className={e.value < 0 ? 'neg' : 'pos'} style={{ width: (Math.abs(e.value) / big * 100) + '%' }} /></span>
      <b className={e.value < 0 ? 'neg' : 'pos'}>{e.value < 0 ? '−' : '+'}{fmtN(Math.abs(e.value))}</b>
    </div>
  );
}
