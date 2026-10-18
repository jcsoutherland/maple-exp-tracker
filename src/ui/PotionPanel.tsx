import { potCost } from '../core/session';
import { fmtN } from '../core/util';
import { useCtrl } from './hooks';
import { PotIcon } from './PotionsTab';

/** Potions used this session, per item, with their shop cost (Live, next to the monsters). */
export function PotionPanel() {
  const c = useCtrl();
  const s = c.sess ?? c.lastFinished;
  const pc = s ? potCost(s, c.settings) : null, items = pc?.items ?? [];
  return (
    <div className="xpanel">
      <div className="xhead"><span>Potions used</span>{pc && pc.total > 0 && <span><b>{fmtN(pc.total)}</b> <span className="mut small">mesos</span></span>}</div>
      {items.length ? (
        <div className="potlines">
          {items.map(i => (
            <div key={i.kind + i.name} className="potline">
              <PotIcon p={i} />
              <span className="pn">{i.name}</span>
              <b>×{fmtN(i.count)}</b>
              <span className="mut small">{fmtN(i.cost)} mesos</span>
            </div>
          ))}
        </div>
      ) : <div className="mut small">None yet.</div>}
    </div>
  );
}
