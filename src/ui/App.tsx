import { useEffect, useRef, useState } from 'react';
import { DropsTab } from './DropsTab';
import { celebrateLevel, playFireworks } from './fireworks';
import { HistoryTab } from './HistoryTab';
import { LiveTab } from './LiveTab';
import { MiniOverlay, useOverlayStats, usePip } from './MiniOverlay';
import { PotionsTab } from './PotionsTab';
import { SetupTab } from './SetupTab';
import { toast, useCtrl } from './hooks';
import { appSeen, DESKTOP_DOWNLOAD, downloadApp, inDesktopApp } from '../app/desktopLink';

const TABS = { live: 'Live', pots: 'Potions', drops: 'Drops', hist: 'History', setup: 'Setup' } as const;
type Tab = keyof typeof TABS;

/** Folder-tab icons (24×24, stroked in the tab's colour when open). */
const ICONS: Record<Tab, JSX.Element> = {
  live: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  pots: <><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" /><path d="M7.5 15h9" /></>,
  drops: <><path d="M5 8h14l-1.2 12H6.2z" /><path d="M9 8V6.5a3 3 0 0 1 6 0V8" /></>,
  hist: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  setup: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
};

export function App() {
  const c = useCtrl();
  // Pop-out overlay: the desktop app when it's installed (it has connected from this browser before), else the browser
  // pop-out on the same click (which has to come straight from the click, so it can't wait to find out). It never
  // downloads. The ⬇ button always opens the app, or downloads it.
  // decided when clicked: whether the app has been seen can change without this header redrawing
  const wantApp = () => !inDesktopApp() && (c.desktop.state === 'connected' || appSeen());
  const [opening, setOpening] = useState(false);
  const [noApp, setNoApp] = useState(false);
  const launch = async () => {
    setOpening(true);
    if (c.desktop.state !== 'connected') toast('Opening the desktop overlay…');
    const ok = await c.desktop.launch();
    setOpening(false);
    return ok;
  };
  const popOut = async () => {
    if (opening) return;
    if (!wantApp() || noApp) { void pip.toggle(); return; }
    if (!(await launch())) { setNoApp(true); toast("The desktop overlay didn't open (not installed?). Click Pop-out overlay again for the browser one, or ⬇ to get the app."); }
  };
  const getApp = async () => {
    if (opening) return;
    if (await launch()) { setNoApp(false); return; }
    toast("The desktop overlay isn't installed: downloading the installer (once installed, it keeps itself up to date)");
    downloadApp();
  };
  const [tab, setTab] = useState<Tab>('live');
  const pip = usePip();
  const s = c.sess;

  // a level-up in the running session sets off the fireworks (not one already counted when the page loads)
  const seen = useRef<{ id: number; ups: number } | null>(null);
  useEffect(() => {
    if (!s) { seen.current = null; return; }
    const prev = seen.current;
    if (prev?.id === s.id && s.levelUps > prev.ups && s.level) celebrateLevel(s.level - 1, s.level);
    seen.current = { id: s.id, ups: s.levelUps };
  }, [s, s?.levelUps]);

  return (
    <>
      <header>
        {/* easter egg: clicking the logo sets off the fireworks (once the last show has faded) */}
        <h1><img className="logo" src={import.meta.env.BASE_URL + 'favicon.svg'} alt="" onClick={playFireworks} /> MS Classic Training Tracker</h1>
        <span className="sp" />
        <button onClick={popOut} disabled={opening}
          title={wantApp() && !noApp ? 'Opens the desktop overlay app' : 'Always-on-top mini overlay'}>⧉ {opening ? 'Opening…' : 'Pop-out overlay'}</button>
        {!inDesktopApp() && (
          <a className="iconbtn" href={DESKTOP_DOWNLOAD} aria-label="Download the overlay as a program"
            onClick={e => { e.preventDefault(); void getApp(); }}
            title="Desktop overlay app: no address bar, always on top of the game. Opens it if it's installed, otherwise downloads it .">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></svg>
          </a>
        )}
      </header>
      <nav className="ftabs">
        {(Object.keys(TABS) as Tab[]).map(k => (
          <button key={k} className={`ftab t-${k}` + (tab === k ? ' act' : '')} onClick={() => setTab(k)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[k]}</svg>
            {TABS[k]}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'live' && <LiveTab />}
        {tab === 'pots' && <PotionsTab />}
        {tab === 'drops' && <DropsTab />}
        {tab === 'hist' && <HistoryTab />}
        {tab === 'setup' && <SetupTab />}
        <div className="credit-line">
          Item and map data from <a href="https://osmsdataexplorer.com" target="_blank" rel="noopener">OSMS Data Explorer</a> by @ohmi; character sprites from <a href="https://maplestory.io" target="_blank" rel="noopener">maplestory.io</a>. Mirrored every three weeks with this site and cached on your device, so these sites aren't asked again per visit.
        </div>
      </main>
      {pip.win && <MiniOverlay win={pip.win} />}
      {c.desktop.state === 'connected' && <DesktopFeed />}
      <div id="toast" />
    </>
  );
}

/**
 * Sends the overlay's numbers to the desktop overlay app while it's connected (on every render: about once a second).
 * Inside the app, the tracker's session goes too, for the website to show live; while the website shows that session,
 * its numbers are the app's own and only say so.
 */
function DesktopFeed() {
  const c = useCtrl(), o = useOverlayStats(), lastMirror = useRef(0);
  useEffect(() => {
    c.desktop.send(c.remote ? { ...o, mirroring: true } : o);
    if (!inDesktopApp() || Date.now() - lastMirror.current < 900) return;
    lastMirror.current = Date.now();
    c.desktop.sendMirror(c.mirrorSnapshot());
  });
  return null;
}
