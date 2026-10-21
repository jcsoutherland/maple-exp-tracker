import type { ReactNode } from 'react';
import { toast, useCtrl } from './hooks';

/**
 * A button that explains itself when disabled: the tooltip sits on a wrapper because disabled buttons get no
 * mouse events (so no hover either).
 */
function Gate({ why, children }: { why: string | null; children: ReactNode }) {
  return why ? <span className="tip" title={why}>{children}</span> : <>{children}</>;
}

/** The Live dashboard's session strip: capture and session status, then share / start / pause / end. */
export function SessionBar() {
  const c = useCtrl();
  const s = c.sess, cap = c.capture;

  const share = async () => {
    try { toast((await c.shareScreen()) ? 'Capturing ✓' : 'No frames received from the shared window yet'); }
    catch (e) { const err = e as DOMException; toast(err.name === 'NotAllowedError' ? 'Capture cancelled' : `Capture failed: ${err.name} ${err.message}`); }
  };
  const stop = () => { c.stop(); toast('Session ended and saved to History'); };

  // why each button is off right now (null = it's on)
  const startWhy = s ? 'A session is already running' : !cap.sharing ? 'Share your game window first'
    : !cap.ready ? 'Waiting for the first frames from the shared window…'
    : c.ocrState === 'error' ? 'The text reader failed to load: reload the page' : c.ocrState !== 'ready' ? 'Getting ready…' : null;
  const sessWhy = s ? null : !cap.sharing ? 'Share your game window, then start a session' : 'Start a session first';

  // the desktop overlay asked this tab to share (its picker only opens from a click here)
  const asked = !cap.sharing && Date.now() - c.shareAsked < 120_000;
  return (
    <div className="ctlbar">
      {asked && <div className="note warnnote" style={{ width: '100%', margin: '0 0 8px' }}><span>The desktop overlay asked to share the game window through this tab: click <b>Share game window</b>, then start the session (here or on the overlay).</span></div>}
      <span className={'pill' + (cap.ready ? ' on' : cap.sharing ? ' warn' : '')}>{cap.ready ? (cap.kind === 'file' ? 'Video: ' + cap.label : 'Capturing') : cap.sharing ? 'Waiting for frames' : 'No capture'}</span>
      <span className={'pill' + (s ? (s.paused ? ' warn' : ' on') : '')}>{!s ? 'Idle' : s.paused ? (c.autoPaused ? 'Paused (idle)' : 'Paused') : 'Tracking'}</span>
      <div className="btns">
        {cap.sharing
          ? <button onClick={() => { c.stopCapture(); toast('Stopped capturing'); }} title="Stop sharing the game window (pauses a running session)">⏹ Stop capture</button>
          : <button className={(s ? '' : 'pri') + (asked ? ' pulse' : '')} onClick={share} title="Pick your MapleStory window to start tracking">Share game window</button>}
        <Gate why={startWhy}><button className={cap.sharing ? 'pri' : ''} disabled={!!startWhy} onClick={() => c.start()}>▶ Start session</button></Gate>
        <Gate why={sessWhy}><button disabled={!!sessWhy} onClick={() => c.togglePause()}>{s?.paused ? '▶ Resume' : '⏸ Pause'}</button></Gate>
        <Gate why={sessWhy}><button className="danger" disabled={!!sessWhy} onClick={stop} title="End this session: save it to History and clear the dashboard for a fresh start">■ End &amp; save</button></Gate>
      </div>
      {!cap.sharing && !s && <div className="ctlhint">Start, Pause and End unlock once you share your game window.</div>}
    </div>
  );
}
