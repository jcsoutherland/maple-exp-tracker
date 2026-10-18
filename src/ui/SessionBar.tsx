import { toast, useCtrl } from './hooks';

/** The Live dashboard's session strip: capture and session status, then share / start / pause / end. */
export function SessionBar() {
  const c = useCtrl();
  const s = c.sess, cap = c.capture;

  const share = async () => {
    try { toast((await c.shareScreen()) ? 'Capturing ✓' : 'No frames received from the shared window yet'); }
    catch (e) { const err = e as DOMException; toast(err.name === 'NotAllowedError' ? 'Capture cancelled' : `Capture failed: ${err.name} ${err.message}`); }
  };
  const stop = () => { c.stop(); toast('Session ended and saved to History'); };
  const startWhy = s ? 'A session is already running' : !cap.ready ? 'Share the game window first'
    : c.ocrState === 'error' ? 'The text reader failed to load: reload the page' : c.ocrState !== 'ready' ? 'Getting ready…' : 'Start tracking';

  return (
    <div className="ctlbar">
      <span className={'pill' + (cap.ready ? ' on' : cap.sharing ? ' warn' : '')}>{cap.ready ? (cap.kind === 'file' ? 'Video: ' + cap.label : 'Capturing') : cap.sharing ? 'Waiting for frames' : 'No capture'}</span>
      <span className={'pill' + (s ? (s.paused ? ' warn' : ' on') : '')}>{!s ? 'Idle' : s.paused ? (c.autoPaused ? 'Paused (idle)' : 'Paused') : 'Tracking'}</span>
      <div className="btns">
        {cap.sharing
          ? <button onClick={() => { c.stopCapture(); toast('Stopped capturing'); }} title="Stop sharing the game window (pauses a running session)">⏹ Stop capture</button>
          : <button onClick={share}>Share game window</button>}
        <button className="pri" disabled={!!s || !cap.ready || c.ocrState !== 'ready'} title={startWhy} onClick={() => c.start()}>▶ Start session</button>
        <button disabled={!s} onClick={() => c.togglePause()}>{s?.paused ? '▶ Resume' : '⏸ Pause'}</button>
        <button className="danger" disabled={!s} onClick={stop} title="End this session: save it to History and clear the dashboard for a fresh start">■ End &amp; save</button>
      </div>
    </div>
  );
}
