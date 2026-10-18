import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { potCost } from '../core/session';
import { fmtDur, fmtK, fmtN } from '../core/util';
import { toast, useCtrl } from './hooks';

interface DocPip { requestWindow(o: { width: number; height: number }): Promise<Window> }

/** Opens an always-on-top Document Picture-in-Picture window (Chrome/Edge 116+), falling back to a normal popup. */
export function usePip() {
  const [win, setWin] = useState<Window | null>(null);
  const toggle = useCallback(async () => {
    if (win) { win.close(); return; }
    try {
      const dp = (window as unknown as { documentPictureInPicture?: DocPip }).documentPictureInPicture;
      const w = dp ? await dp.requestWindow({ width: 250, height: 210 }) : window.open('', 'mapleMini', 'width=260,height=240');
      if (!w) return;
      if (!dp) toast('Always-on-top needs Chrome/Edge 116+; opened a normal popup');
      w.document.title = 'EXP';
      document.querySelectorAll('style, link[rel="stylesheet"]').forEach(n => w.document.head.append(n.cloneNode(true)));
      w.document.body.style.margin = '0';
      w.addEventListener('pagehide', () => setWin(null));
      setWin(w);
    } catch (e) { toast('Pop-out failed: ' + (e as Error).message); }
  }, [win]);
  useEffect(() => () => win?.close(), [win]);
  return { win, toggle };
}

export function MiniOverlay({ win }: { win: Window }) {
  const c = useCtrl();
  const s = c.sess, t = c.tracker, { el, hr } = c.rates();
  return createPortal(
    <div className="mini">
      <div className="r">
        <b style={{ color: !s ? undefined : s.paused ? 'var(--warm)' : 'var(--ok)' }}>{!s ? 'Idle' : s.paused ? 'Paused' : '● Tracking'}</b>
        <span>{fmtDur(el)}</span>
      </div>
      <div className="big">{hr != null ? fmtK(hr) : '—'} /hr</div>
      <div className="r"><span>EXP</span><span>{fmtN(s?.exp ?? 0)}</span></div>
      <div className="r"><span>Level</span><span>{t?.pct != null ? `${s?.level ? 'Lv' + s.level + ' · ' : ''}${t.pct.toFixed(2)}%` : '—'}</span></div>
      <div className="r"><span>Mesos</span><span>{fmtN(s?.mesos ?? 0)}</span></div>
      <div className="r"><span>Pots</span><span>-{fmtN(s ? potCost(s, c.settings).total : 0)}</span></div>
      {s && s.expLost > 0 && <div className="r"><span>EXP lost</span><span style={{ color: 'var(--bad)' }}>-{fmtN(s.expLost)}</span></div>}
      <div className="r"><span>Map</span><span style={{ textAlign: 'right', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', maxWidth: 150 }}>{t ? t.mapName : '—'}</span></div>
      <div className="r" style={{ marginTop: 6, justifyContent: 'flex-start', gap: 4 }}>
        <button disabled={!!s || !c.capture.ready || c.ocrState !== 'ready'} onClick={() => c.start()}>▶</button>
        <button disabled={!s} onClick={() => c.togglePause()}>{s?.paused ? '▶' : '⏸'}</button>
      </div>
    </div>,
    win.document.body,
  );
}
