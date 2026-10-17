import { itemByName } from '../core/data/osms';
import type { Drop } from '../core/session';
import { fmtN } from '../core/util';
import { useCtrl, useItemIcon } from './hooks';

export function DropTable({ drops }: { drops: Record<string, Drop> }) {
  const rows = Object.entries(drops).sort((a, b) => b[1].qty - a[1].qty);
  let total = 0;
  const body = rows.map(([name, d]) => {
    const rec = itemByName(name), price = rec?.price ?? null;
    if (price) total += price * d.qty;
    return <DropRow key={name} name={name} d={d} id={d.id ?? rec?.id} price={price} />;
  });
  return (
    <>
      <table>
        <thead><tr><th /><th>Item</th><th className="n">Qty</th><th className="n">NPC price</th><th className="n">Total</th></tr></thead>
        <tbody>{body.length ? body : <tr><td colSpan={5} className="mut">No drops read yet.</td></tr>}</tbody>
      </table>
      <div className="row" style={{ marginTop: 8 }}><span className="mut">Estimated NPC value:</span><b>{fmtN(total)} mesos</b></div>
    </>
  );
}

function DropRow({ name, d, id, price }: { name: string; d: Drop; id?: number; price: number | null }) {
  const icon = useItemIcon(id);
  return (
    <tr>
      <td>{icon && <img className="ic" src={icon} alt="" />}</td>
      <td>{name} <span className="mut small">{d.cat}</span>{!id && <span className="mut small"> (unmatched)</span>}</td>
      <td className="n">{fmtN(d.qty)}</td>
      <td className="n">{price != null ? fmtN(price) : '—'}</td>
      <td className="n">{price ? fmtN(price * d.qty) : '—'}</td>
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
        <div className="mut small" style={{ marginTop: 8 }}>OCR'd names are matched to the MapleStory Classic World item list; icons and NPC prices are fetched once and cached.</div>
      </div>
    </section>
  );
}
