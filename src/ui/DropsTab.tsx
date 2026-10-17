import { itemByName, MESO_WATCH_URL, meowdbUrl } from '../core/data/osms';
import type { Drop } from '../core/session';
import { fmtN } from '../core/util';
import { toast, useCtrl, useItemIcon } from './hooks';

/** Drops as one readable column (icon · name ×qty), NPC value, and links to player-market prices. */
export function DropTable({ drops, compact }: { drops: Record<string, Drop>; compact?: boolean }) {
  const rows = Object.entries(drops).map(([name, d]) => {
    const rec = itemByName(name), price = rec?.price ?? null;
    return { name, d, id: d.id ?? rec?.id, price, total: price ? price * d.qty : 0 };
  }).sort((a, b) => b.total - a.total || b.d.qty - a.d.qty);
  const total = rows.reduce((a, r) => a + r.total, 0);
  if (!rows.length) return <div className="mut">No drops read yet.</div>;
  return (
    <>
      <table className="drops">
        <thead><tr><th>Item</th><th className="n">NPC each</th><th className="n">NPC total</th>{!compact && <th>Player price</th>}</tr></thead>
        <tbody>{rows.map(r => <DropRow key={r.name} {...r} compact={compact} />)}</tbody>
      </table>
      <div className="row" style={{ marginTop: 8 }}><span className="mut">NPC value of everything:</span><b>{fmtN(total)} mesos</b></div>
    </>
  );
}

function DropRow({ name, d, id, price, total, compact }: { name: string; d: Drop; id?: number; price: number | null; total: number; compact?: boolean }) {
  const icon = useItemIcon(id);
  return (
    <tr>
      <td>
        <div className="item">
          <span className="ic-wrap">{icon && <img className="ic" src={icon} alt="" />}</span>
          <span><b>{name}</b> <span className="qty">×{fmtN(d.qty)}</span>{d.cat && <span className="mut small"> · {d.cat}</span>}</span>
        </div>
      </td>
      <td className="n">{price != null ? fmtN(price) : '—'}</td>
      <td className="n">{total ? fmtN(total) : '—'}</td>
      {!compact && (
        <td className="links">
          <a href={meowdbUrl(name)} target="_blank" rel="noopener">meowdb ↗</a>
          <a href={MESO_WATCH_URL} target="_blank" rel="noopener" title="Opens meso.watch with the item name copied — paste it into the filter"
            onClick={() => navigator.clipboard?.writeText(name).then(() => toast(`“${name}” copied — paste it into meso.watch's filter`), () => undefined)}>meso.watch ↗</a>
        </td>
      )}
    </tr>
  );
}

export function DropsTab() {
  const c = useCtrl();
  const s = c.sess || c.lastFinished;
  return (
    <section>
      <div className="card">
        <h3>Drops this session</h3>
        <DropTable drops={s?.drops ?? {}} />
        <div className="mut small" style={{ marginTop: 8 }}>
          Names are matched to the MapleStory Classic World item list. NPC price is what a shop pays; compare with player prices on meowdb or meso.watch.
        </div>
      </div>
    </section>
  );
}
