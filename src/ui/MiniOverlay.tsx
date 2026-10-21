import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { featureOn, type Feature } from '../core/config';
import { fmtDur, fmtHM, fmtK, fmtN } from '../core/util';
import { useGoal, useRate } from './GoalPanel';
import { toast, useCtrl } from './hooks';
import { sessionNet } from './LootProfit';

interface DocPip { requestWindow(o: { width: number; height: number }): Promise<Window> }

/**
 * Opens the overlay as a Document Picture-in-Picture window (Chrome/Edge 116+): always on top of other windows, the game
 * included, with only a thin title strip (the browser always shows the site there; a page can't hide it). Browsers
 * without it get a normal popup, which can't stay on top. The desktop overlay app has neither (see desktopLink.ts).
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

/** What the overlay shows, ready to display: the pop-out window and the desktop app show exactly this. */
export interface OverlayStats {
  state: 'idle' | 'paused' | 'on'; time: string; name: string; level: number | null; exp: string; pct: number;
  tiles: { label: string; value: string; cls?: 'pos' | 'neg' }[];
  /** the one play / pause button: what it does now, and whether it can */
  action: 'start' | 'pause' | 'resume'; actionOk: boolean;
  /** the game window is being shared with this tracker */
  sharing: boolean;
  /** ■ has something to end: a session, or a shared window */
  canStop: boolean;
}

/** The overlay's numbers: level and EXP bar, recent and session EXP, time to the level goal, and profit. */
export function useOverlayStats(): OverlayStats {
  const c = useCtrl();
  const s = c.sess, t = c.tracker, { el, hr, r10 } = c.rates(), rate = useRate(), { level, goal, remaining } = useGoal();
  const last5 = c.gainOver(5 * 60_000), money = s ? sessionNet(s, c.settings) : null;
  const on = (f: Feature) => featureOn(c.settings, f), pct = t?.pct ?? null;
  const tiles: OverlayStats['tiles'] = [];
  if (on('expGain')) tiles.push({ label: 'Last 5 min', value: last5 != null ? signed(last5) : '—', cls: 'pos' });
  if (on('expRate')) tiles.push({ label: `EXP/h · ${r10 ? '10m' : 'all'}`, value: r10 || hr ? fmtK((r10 || hr)!) : '—' });
  if (on('expGain')) tiles.push({ label: 'This session', value: s ? signed(s.exp) : '—', cls: 'pos' });
  if (on('levelGoal')) tiles.push({ label: `To Lv. ${goal ?? '?'}`, value: remaining && rate ? fmtHM(remaining / rate * 3.6e6) : '—' });
  if (on('mesos') || on('drops')) tiles.push({ label: 'Profit', value: money ? signed(money.net) : '—', cls: money && money.net < 0 ? 'neg' : 'pos' });
  return {
    state: !s ? 'idle' : s.paused ? 'paused' : 'on', time: s ? fmtDur(el) : '', name: c.identity.name || '', level,
    exp: `${t?.exp != null ? fmtN(t.exp) : '—'} ${pct != null ? `[${pct.toFixed(2)}%]` : ''}`.trim(), pct: pct ?? 0, tiles,
    // with no session, ▶ shares the game window first when needed (see controller.startFromOverlay)
    action: !s ? 'start' : s.paused ? 'resume' : 'pause', actionOk: !!s || c.ocrState !== 'error',
    sharing: c.capture.sharing || (c.capture.kind === 'file' && c.capture.ready),
    canStop: !!s || c.capture.sharing,
  };
}

const ACTION_TITLE = { start: 'Start a session (shares the game window first if needed)', pause: 'Pause', resume: 'Resume' } as const;
/** Play and pause drawn as a pair: the same box, the same weight. */
export function PlayPause({ action }: { action: OverlayStats['action'] }) {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      {action === 'pause' ? <><rect x="1.8" y="1.2" width="2.3" height="7.6" rx=".5" fill="currentColor" /><rect x="5.9" y="1.2" width="2.3" height="7.6" rx=".5" fill="currentColor" /></>
        : <path d="M2.4 1.4 8.6 5 2.4 8.6Z" fill="currentColor" stroke="currentColor" strokeWidth=".8" strokeLinejoin="round" />}
    </svg>
  );
}

/** The always-on-top pop-out overlay (in the browser). */
export function MiniOverlay({ win }: { win: Window }) {
  const c = useCtrl(), o = useOverlayStats();
  return createPortal(
    <div className="ov">
      <div className="ov-head">
        <span className={'ov-dot ' + o.state} title={o.state === 'on' ? 'Tracking' : o.state === 'paused' ? 'Paused' : 'Not tracking'} />
        <b>EXP TRACKER</b>
        <span className="ov-time">{o.time}</span>
        <span className="sp" />
        <span className="ov-name">{o.name}</span>
        <button className="ov-pp" disabled={!o.actionOk} title={ACTION_TITLE[o.action]}
          onClick={() => void c.startFromOverlay().then(why => {
            if (why === 'needs-click') toast('Click "Share game window" on the tracker page first');
            else if (why === 'not-ready') toast("The shared window isn't sending frames yet: try ▶ again in a moment");
          })}><PlayPause action={o.action} /></button>
      </div>
      <div className="ov-bar">
        <span className="ov-lv">LV.<b>{o.level ?? '?'}</b></span>
        <div className="ov-exp">
          <div style={{ width: o.pct + '%' }} />
          <span><i>EXP</i> {o.exp}</span>
        </div>
      </div>
      <div className="ov-stats">
        {o.tiles.map(t => <div key={t.label}><span>{t.label}</span><b className={t.cls}>{t.value}</b></div>)}
      </div>
    </div>,
    win.document.body,
  );
}
