import { useEffect, useState } from 'react';
import { mobByName, mobImage, mobsOnMap, mobsReady, type MobRec } from '../core/data/osms';
import { fmtN } from '../core/util';
import { useCtrl } from './hooks';

/** Object URL of a monster's animated idle image (fetched once, then from this device). */
function useMobImage(m: MobRec | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (m) mobImage(m).then(u => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [m?.id]);
  return url;
}

/**
 * What you're training on: the monster whose etc drops came in most recently this session (with how many), or before
 * any drops, the monsters that live on the current map.
 */
export function MonsterCard() {
  const c = useCtrl();
  const s = c.sess, map = c.tracker?.mapCur ?? null;
  if (!s || !mobsReady()) return null;
  const fought = Object.entries(s.mobs ?? {}).sort((a, b) => b[1].last - a[1].last)
    .map(([n, v]) => ({ m: mobByName(n), n: v.n })).filter((x): x is { m: MobRec; n: number } => !!x.m);
  const list = fought.length ? fought : mobsOnMap(map).filter(m => !m.boss).sort((a, b) => b.exp - a.exp).map(m => ({ m, n: 0 }));
  if (!list.length) return null;
  const [main, ...rest] = list;
  return (
    <div className="mobcard" title={fought.length ? 'From your etc drops this session' : 'Monsters on this map'}>
      <MobPic m={main.m} />
      <div className="mobinfo">
        <span className="mut small">{fought.length ? 'Training on' : 'On this map'}</span>
        <b>{main.m.name}</b>
        <span className="mut small">Lv {main.m.level} · {fmtN(main.m.exp)} EXP{main.n ? ` · ${fmtN(main.n)} drop${main.n > 1 ? 's' : ''}` : ''}</span>
        {rest.length > 0 && <span className="mut small">also {rest.slice(0, 3).map(r => r.m.name + (r.n ? ` (${fmtN(r.n)})` : '')).join(', ')}</span>}
      </div>
    </div>
  );
}

function MobPic({ m }: { m: MobRec }) {
  const url = useMobImage(m);
  return <div className="mobpic">{url && <img src={url} alt="" />}</div>;
}
