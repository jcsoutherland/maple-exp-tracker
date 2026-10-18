import { useEffect, useState } from 'react';
import { mobByName, mobImage, mobsOnMap, mobsReady, type MobRec } from '../core/data/osms';
import { fmtN } from '../core/util';
import { useCtrl } from './hooks';

/** meowdb's monster pages use the same ids as the OSMS data */
const meowdbMob = (m: MobRec) => `https://meowdb.com/msclassic/monsters/${m.id}`;

/** Object URL of a monster's animated idle image (fetched once, then from this device). */
function useMobImage(m: MobRec) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    mobImage(m).then(u => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [m.id]);
  return url;
}

/**
 * Monsters here: every monster on the current map plus any whose etc drops came in this session, as small tiles.
 * The one whose drop came in last is marked as what you're training on; names link to their meowdb page.
 */
export function MonsterPanel() {
  const c = useCtrl();
  const s = c.sess ?? c.lastFinished, map = c.tracker?.mapCur ?? null;
  if (!mobsReady()) return null;
  const fought = new Map(Object.entries(s?.mobs ?? {}));
  const latest = [...fought].sort((a, b) => b[1].last - a[1].last)[0]?.[0] ?? null;
  const list: MobRec[] = [];
  for (const n of [...fought.keys()].sort((a, b) => fought.get(b)!.last - fought.get(a)!.last)) { const m = mobByName(n); if (m) list.push(m); }
  for (const m of mobsOnMap(map).sort((a, b) => a.level - b.level)) if (!list.some(x => x.id === m.id)) list.push(m);
  return (
    <div className="xpanel">
      <div className="xhead"><span>Monsters</span><span className="mut small">{map ?? 'map unknown'}</span></div>
      {list.length ? (
        <div className="mobgrid">
          {list.map(m => <MobTile key={m.id} m={m} cur={m.name === latest} />)}
        </div>
      ) : (
        <div className="mob-empty">
          <img src={import.meta.env.BASE_URL + 'favicon.svg'} alt="" />
          <b>No monsters known for this map</b>
          <span>They appear here when you're on a hunting map or an etc drop comes in.</span>
        </div>
      )}
    </div>
  );
}

function MobTile({ m, cur }: { m: MobRec; cur: boolean }) {
  const url = useMobImage(m);
  return (
    <div className={'mobtile' + (cur ? ' cur' : '')} title={cur ? 'Training on this (latest etc drop)' : undefined}>
      <div className="mobpic">{url && <img src={url} alt="" />}</div>
      <a href={meowdbMob(m)} target="_blank" rel="noopener" title="Open on meowdb">{m.name}</a>
      <span className="mut small">Lv {m.level} · {fmtN(m.exp)} EXP{m.boss ? ' · boss' : ''}</span>
      {m.weak?.length ? <span className="weak">{m.weak.map(w => <i key={w} className={'el el-' + w.toLowerCase()}>{w}</i>)}</span> : null}
    </div>
  );
}
