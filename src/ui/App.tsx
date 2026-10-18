import { useState } from 'react';
import { DropsTab } from './DropsTab';
import { HistoryTab } from './HistoryTab';
import { LiveTab } from './LiveTab';
import { MiniOverlay, usePip } from './MiniOverlay';
import { PotionsTab } from './PotionsTab';
import { SetupTab } from './SetupTab';
import { toast, useCtrl } from './hooks';

const TABS = { live: 'Live', pots: 'Potions', drops: 'Drops', hist: 'History', setup: 'Setup' } as const;
type Tab = keyof typeof TABS;

export function App() {
  const c = useCtrl();
  const [tab, setTab] = useState<Tab>('live');
  const pip = usePip();
  const s = c.sess, cap = c.capture;

  const share = async () => {
    try { toast((await c.shareScreen()) ? 'Capturing ✓' : 'No frames received from the shared window yet'); }
    catch (e) { const err = e as DOMException; toast(err.name === 'NotAllowedError' ? 'Capture cancelled' : `Capture failed: ${err.name} ${err.message}`); }
  };
  const stop = () => { c.stop(); toast('Session ended and saved to History'); };

  return (
    <>
      <header>
        <h1><img className="logo" src={import.meta.env.BASE_URL + 'favicon.svg'} alt="" /> MS Classic Training Tracker</h1>
        <span className={'pill' + (cap.ready ? ' on' : cap.sharing ? ' warn' : '')}>{cap.ready ? (cap.kind === 'file' ? 'Video: ' + cap.label : 'Capturing') : cap.sharing ? 'Waiting for frames' : 'No capture'}</span>
        <span className={'pill' + (c.ocrState === 'ready' ? ' on' : c.ocrState === 'loading' ? ' warn' : '')}>
          {{ idle: 'OCR not loaded', loading: 'Loading OCR…', ready: 'OCR ready', error: 'OCR failed' }[c.ocrState]}
        </span>
        <span className={'pill' + (s ? (s.paused ? ' warn' : ' on') : '')}>{!s ? 'Idle' : s.paused ? (c.autoPaused ? 'Paused (idle)' : 'Paused') : 'Tracking'}</span>
        <span className="sp" />
        {cap.sharing
          ? <button onClick={() => { c.stopCapture(); toast('Stopped capturing'); }} title="Stop sharing the game window (pauses a running session)">⏹ Stop capture</button>
          : <button onClick={share}>Share game window</button>}
        <button className="pri" disabled={!!s || !cap.ready || c.ocrState !== 'ready'} onClick={() => c.start()}>▶ Start session</button>
        <button disabled={!s} onClick={() => c.togglePause()}>{s?.paused ? '▶ Resume' : '⏸ Pause'}</button>
        <button className="danger" disabled={!s} onClick={stop} title="End this session: save it to History and clear the dashboard for a fresh start">■ End &amp; save</button>
        <button onClick={pip.toggle} title="Always-on-top mini overlay">⧉ Pop-out overlay</button>
      </header>
      <nav>
        {(Object.keys(TABS) as Tab[]).map(k => <button key={k} className={tab === k ? 'act' : ''} onClick={() => setTab(k)}>{TABS[k]}</button>)}
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
