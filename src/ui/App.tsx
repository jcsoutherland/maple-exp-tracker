import { useEffect, useRef, useState } from 'react';
import { DropsTab } from './DropsTab';
import { celebrateLevel, playFireworks } from './fireworks';
import { HistoryTab } from './HistoryTab';
import { LiveTab } from './LiveTab';
import { MiniOverlay, usePip } from './MiniOverlay';
import { PotionsTab } from './PotionsTab';
import { SetupTab } from './SetupTab';
import { useCtrl } from './hooks';

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
        <button onClick={pip.toggle} title="Always-on-top mini overlay">⧉ Pop-out overlay</button>
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
          Item and map data from <a href="https://osmsdataexplorer.com" target="_blank" rel="noopener">OSMS Data Explorer</a> by @ohmi; character sprites from <a href="https://maplestory.io" target="_blank" rel="noopener">maplestory.io</a>. Mirrored weekly with this site and cached on your device, so these sites aren't asked again per visit.
        </div>
      </main>
      {pip.win && <MiniOverlay win={pip.win} />}
      <div id="toast" />
    </>
  );
}
