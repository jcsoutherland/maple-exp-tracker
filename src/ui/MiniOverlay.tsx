import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { fmtDur, fmtHM, fmtK, fmtN } from '../core/util';
import { useGoal, useRate } from './GoalPanel';
import { toast, useCtrl } from './hooks';
import { sessionNet } from './LootProfit';

interface DocPip { requestWindow(o: { width: number; height: number }): Promise<Window> }

/**
 * Opens the overlay as a Document Picture-in-Picture window (Chrome/Edge 116+): always on top of other windows, the game
 * included, with only a thin title strip (the browser always shows the site there; a page can't hide it). Browsers
 * without it get a normal popup, which can't stay on top.
 */
export function usePip() {
  const [win, setWin] = useState<Window | null>(null);
  const toggle = useCallback(async () => {
    if (win) { win.close(); return; }
    try {
      const dp = (window as unknown as { documentPictureInPicture?: DocPip }).documentPictureInPicture;
      const w = dp ? await dp.requestWindow({ width: 380, height: 126 }) : window.open('', 'mapleMini', 'width=380,height=170,popup');
      if (!w) return;
      if (!dp) toast("This browser can't keep a window on top of the game: open the site in Chrome or Edge for that");
      w.document.title = 'EXP Tracker';
      document.querySelectorAll('style, link[rel="stylesheet"]').forEach(n => w.document.head.append(n.cloneNode(true)));
      w.document.body.style.margin = '0';
      w.addEventListener('pagehide', () => setWin(null));
      setWin(w);
    } catch (e) { toast('Pop-out failed: ' + (e as Error).message); }
  }, [win]);
  useEffect(() => () => win?.close(), [win]);
  return { win, toggle };
}

const signed = (n: number, f = fmtK) => (n < 0 ? '−' : '+') + f(Math.abs(n));

/** The always-on-top overlay: level and EXP bar, recent and session EXP, time to the level goal, and profit. */
export function MiniOverlay({ win }: { win: Window }) {
  const c = useCtrl();
  const s = c.sess, t = c.tracker, { el, hr, r10 } = c.rates(), rate = useRate(), { level, goal, remaining } = useGoal();
  const last5 = c.gainOver(5 * 60_000), money = s ? sessionNet(s, c.settings) : null;
  const pct = t?.pct ?? null, state = !s ? 'idle' : s.paused ? 'paused' : 'on';
  return createPortal(
    <div className="ov">
      <div className="ov-head">
        <span className={'ov-dot ' + state} title={state === 'on' ? 'Tracking' : state === 'paused' ? 'Paused' : 'Not tracking'} />
        <b>EXP TRACKER</b>
        <span className="ov-time">{s ? fmtDur(el) : ''}</span>
        <span className="sp" />
        <span className="ov-name">{c.identity.name || ''}</span>
        <button disabled={!!s || !c.capture.ready || c.ocrState !== 'ready'} onClick={() => c.start()} title="Start">▶</button>
        <button disabled={!s} onClick={() => c.togglePause()} title={s?.paused ? 'Resume' : 'Pause'}>{s?.paused ? '▶' : '⏸'}</button>
      </div>
      <div className="ov-bar">
        <span className="ov-lv">LV.<b>{level ?? '?'}</b></span>
        <div className="ov-exp">
          <div style={{ width: (pct ?? 0) + '%' }} />
          <span><i>EXP</i> {t?.exp != null ? fmtN(t.exp) : '—'} {pct != null ? `[${pct.toFixed(2)}%]` : ''}</span>
        </div>
      </div>
      <div className="ov-stats">
        <div><span>Last 5 min</span><b className="pos">{last5 != null ? signed(last5) : '—'}</b></div>
        <div><span>EXP/h · {r10 ? '10m' : 'all'}</span><b>{r10 || hr ? fmtK((r10 || hr)!) : '—'}</b></div>
        <div><span>This session</span><b className="pos">{s ? signed(s.exp) : '—'}</b></div>
        <div><span>To Lv. {goal ?? '?'}</span><b>{remaining && rate ? fmtHM(remaining / rate * 3.6e6) : '—'}</b></div>
        <div><span>Profit</span><b className={money && money.net < 0 ? 'neg' : 'pos'}>{money ? signed(money.net) : '—'}</b></div>
      </div>
    </div>,
    win.document.body,
  );
}
