import { useEffect, useRef, useState } from 'react';
import type { OcrTestRow } from '../app/controller';
import { AUTO_PAUSE_OFF_WHY, canAutoPause, FEATURES, featureOn, REGION_DEFS, type Feature, type RegionKey, type Schedule, type UiRatio } from '../core/config';
import { attachSelect, type FracRect } from './selectable';
import { toast, useCtrl } from './hooks';
import { NumberInput } from './NumberInput';
import { DESKTOP_DOWNLOAD, inDesktopApp } from '../app/desktopLink';
import { downloadDiag } from '../core/diaglog';

export function SetupTab() {
  const c = useCtrl();
  const cv = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState<HTMLCanvasElement | null>(null);
  const [sel, setSel] = useState<RegionKey>('map');
  const [rows, setRows] = useState<OcrTestRow[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [rate, setRate] = useState(1);

  const grab = () => { if (!c.capture.ready) { toast('Share the game window first'); return null; } const f = c.capture.snapshot(); setFrame(f); return f; };
  useEffect(() => { if (c.capture.ready && !frame) grab(); }, [c.capture.ready]);

  const draw = (tmp?: FracRect) => {
    const el = cv.current;
    if (!el) return;
    if (frame) el.height = Math.round(el.width * frame.height / frame.width);
    const x = el.getContext('2d')!;
    x.fillStyle = '#000'; x.fillRect(0, 0, el.width, el.height);
    if (frame) x.drawImage(frame, 0, 0, el.width, el.height);
    else { x.fillStyle = '#9097a8'; x.font = `${Math.round(el.width / 40)}px system-ui`; x.fillText('Share the game window (or load a video), then click "Grab frame"', el.width / 40, el.width / 20); }
    const u = el.width / 960; // drawing units: labels and lines stay readable at the full-width size
    for (const k of Object.keys(REGION_DEFS) as RegionKey[]) {
      const r = c.regions[k], d = REGION_DEFS[k];
      x.strokeStyle = d.color; x.lineWidth = (k === sel ? 3 : 1.5) * u;
      x.strokeRect(r.x * el.width, r.y * el.height, r.w * el.width, r.h * el.height);
      x.fillStyle = d.color; x.font = `${Math.round(11 * u)}px system-ui`; x.fillText(d.label, r.x * el.width, Math.max(10 * u, r.y * el.height - 3 * u));
    }
    if (tmp) { x.setLineDash([4 * u, 3 * u]); x.strokeStyle = '#fff'; x.lineWidth = 1.5 * u; x.strokeRect(tmp.x * el.width, tmp.y * el.height, tmp.w * el.width, tmp.h * el.height); x.setLineDash([]); }
  };
  useEffect(() => draw());
  useEffect(() => (cv.current ? attachSelect(cv.current, r => draw(r), r => c.setRegion(sel, r)) : undefined));

  const test = async () => {
    const f = grab();
    if (!f) return;
    if (c.ocrState !== 'ready') { toast('OCR still loading…'); return; }
    setTesting(true);
    try { setRows(await c.testOcr(f)); } finally { setTesting(false); }
  };
  const saveFrame = () => {
    const f = grab();
    if (!f) return;
    const a = document.createElement('a');
    a.href = f.toDataURL('image/png');
    a.download = `maple-frame-${f.width}x${f.height}-${Date.now()}.png`;
    a.click();
  };
  const sched = c.settings.schedule;
  const setSched = (k: keyof Schedule, v: number) => c.updateSettings({ schedule: { ...sched, [k]: v } });

  return (
    <section>
      <div className="card">
        <h3>Quick start</h3>
        <ol className="help">
          <li>Click <b>Share game window</b> and pick the MapleStory window (not the whole screen). Run the game windowed or borderless.</li>
          <li>Set <b>In-game UI</b> to the game's UI ratio setting (Ideal or Default), then click <b>Grab frame</b>. Each coloured box should cover its text; to fix one, select it in the list and drag a new box on the image.</li>
          <li>Click <b>Test OCR</b>. If a black-on-white preview is messy, adjust that region's threshold.</li>
          <li>On <b>Live</b>, check name/class/level and press <b>▶ Start session</b>. <b>⧉ Pop-out overlay</b> gives an always-on-top mini window.</li>
        </ol>
      </div>
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <button onClick={grab}>Grab frame</button>
          <button onClick={test} disabled={testing}>{testing ? 'Reading…' : 'Test OCR'}</button>
          <button onClick={saveFrame} title="Save the current frame as a PNG (useful for bug reports / tuning)">Save frame</button>
          <span className="sp" />
          <label title="Match the game's UI ratio setting. Default ratio scales the HUD with the window; Ideal ratio keeps it at its native size. Each keeps its own regions.">
            In-game UI <select value={c.settings.uiRatio} onChange={e => c.setUiRatio(e.target.value as UiRatio)}>
              <option value="ideal">Ideal ratio</option><option value="default">Default ratio</option></select></label>
          <button className="danger" onClick={() => c.resetRegions()} title="Put this UI ratio's regions back to their defaults">Reset regions</button>
        </div>
        <canvas ref={cv} id="setupCanvas" width={1920} height={1080} />
        <div className="mut small" style={{ marginTop: 6 }}>Selected: <b>{REGION_DEFS[sel].label}</b>. Drag on the image to set this region.</div>
      </div>
      <div className="grid2">
        <div className="card">
          <h3>Regions</h3>
          {(Object.keys(REGION_DEFS) as RegionKey[]).map(k => (
            <div key={k} className={'reg' + (k === sel ? ' sel' : '')} onClick={() => setSel(k)}>
              <span className="sw" style={{ background: REGION_DEFS[k].color }} />
              <span className="nm">{REGION_DEFS[k].label}</span>
              {REGION_DEFS[k].gauge ? <span className="mut small">read by colour</span> : <>
                <span className="mut small">thr</span>
                <input type="range" min={60} max={240} value={c.regions[k].thr} onClick={e => e.stopPropagation()} onChange={e => c.setRegion(k, { thr: +e.target.value })} />
                <span className="mut small" style={{ width: 28 }}>{c.regions[k].thr}</span>
              </>}
            </div>
          ))}
        </div>
        <div className="card">
          <h3>OCR test</h3>
          <div className="ocrres">
            {rows ? rows.map(r => (
              <div key={r.key} style={{ display: 'contents' }}>
                <b style={{ color: r.color }}>{r.label}</b>
                <div><img src={r.img} alt="" /><div>{r.parsed}</div><div className="mut small">{r.raw}</div></div>
              </div>
            )) : <span className="mut">Run “Test OCR”.</span>}
          </div>
        </div>
      </div>
      <div className="card">
        <h3>Test with a recording</h3>
        <div className="row">
          <label><button type="button" onClick={e => (e.currentTarget.nextElementSibling as HTMLInputElement).click()}>Load video file…</button>
            <input type="file" accept="video/*" hidden onChange={async e => {
              const f = e.target.files?.[0]; e.target.value = '';
              if (f) { await c.useVideo(f, rate); toast('Playing ' + f.name); setFrame(c.capture.snapshot()); }
            }} /></label>
          <label>Speed <select value={rate} onChange={e => { setRate(+e.target.value); c.capture.video.playbackRate = +e.target.value; }}>
            <option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option></select></label>
          <span className="mut small">Plays a gameplay recording through the tracker as if it were live (recordings are compressed, so live capture reads better).</span>
        </div>
      </div>
      <DesktopOverlayCard />
      <DiagnosticsCard />
      <FeatureSwitches />
      <div className="card">
        <h3>Read schedule &amp; detection</h3>
        <div className="row">
          <label>Pickup-log watch <NumberInput width={70} min={33} max={2000} step={11} value={sched.logWatchMs} onChange={v => setSched('logWatchMs', v)} /> ms</label>
          <label>HP/MP numbers <NumberInput width={70} min={500} max={10000} step={250} value={sched.barsMs} onChange={v => setSched('barsMs', v)} /> ms</label>
          <label title="How often the HP/MP gauges are checked for potions (pixel read, very cheap)">HP/MP gauges <NumberInput width={70} min={50} max={2000} step={50} value={sched.gaugeMs} onChange={v => setSched('gaugeMs', v)} /> ms</label>
          <label>EXP bar <NumberInput width={70} min={1000} max={60000} step={500} value={sched.expMs} onChange={v => setSched('expMs', v)} /> ms</label>
          <label>Map check <NumberInput width={70} min={2000} max={120000} step={1000} value={sched.mapMs} onChange={v => setSched('mapMs', v)} /> ms, and every <NumberInput width={70} min={500} max={1000000} step={500} value={sched.mapExpStep} onChange={v => setSched('mapExpStep', v)} /> EXP</label>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <label title={canAutoPause(c.settings) ? '0 = never. The session resumes by itself when EXP moves again.' : AUTO_PAUSE_OFF_WHY}>Auto-pause after idle (s) <NumberInput width={60} min={0} max={3600} step={5} value={c.settings.idlePauseSec} onChange={v => c.updateSettings({ idlePauseSec: v })} disabled={!canAutoPause(c.settings)} /></label>
          <label>Min HP jump counted as pot <NumberInput width={60} min={1} max={5000} step={5} value={c.settings.hpMin} onChange={v => c.updateSettings({ hpMin: v })} /></label>
          <label>Min MP jump counted as pot <NumberInput width={60} min={1} max={5000} step={5} value={c.settings.mpMin} onChange={v => c.updateSettings({ mpMin: v })} /></label>
        </div>
        <div className="mut small" style={{ marginTop: 8 }}>
          The pickup log is checked for a new line at the watch rate with a cheap pixel comparison; OCR only runs when a line appears.
          Name and class are read once per session, level at start and after each level-up.
        </div>
      </div>
    </section>
  );
}

/** On/off per feature: one switched off stops its screen reading (once nothing else needs it) and leaves the dashboard. */
function FeatureSwitches() {
  const c = useCtrl(), feats = Object.entries(FEATURES) as [Feature, (typeof FEATURES)[Feature]][];
  const set = (f: Feature, on: boolean) => c.updateSettings({ features: { ...c.settings.features, [f]: on } });
  return (
    <div className="card">
      <h3>Features</h3>
      <div className="mut small" style={{ marginBottom: 10 }}>
        Switch off what you don't need for a lighter tracker. A feature that's off is hidden from the dashboard, and its screen
        reading stops once no other feature uses it (the EXP bar is shared by all the EXP features, the pickup log by mesos and drops).
      </div>
      <div className="featgrid">
        {feats.map(([f, d]) => (
          <label key={f} className="featsw" title={d.reads ? 'Reads: ' + d.reads : 'Display only'}>
            <input type="checkbox" role="switch" checked={featureOn(c.settings, f)} onChange={e => set(f, e.target.checked)} />
            <span className="sw" aria-hidden="true" />
            <span>{d.label}<small>{d.reads ? d.reads : 'display only'}</small></span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** The desktop overlay app: what it is, how to get it, and whether it's linked. */
function DesktopOverlayCard() {
  const c = useCtrl(), st = c.desktop.state, inApp = inDesktopApp();
  return (
    <div className="card">
      <h3>Desktop overlay app</h3>
      <div className="mut small" style={{ marginBottom: 10, maxWidth: 720 }}>
        The overlay as its own small Windows app: borderless, always on top of the game, no address bar. Drag it by its top line;
        its <b>⋯</b> menu has the options. It can share the game through Windows and track without this page; your sessions then
        come into History here, and this page shows the session live while it runs. Your Setup here is what the app uses.{' '}
        {!inApp && <>Download it with the <a href={DESKTOP_DOWNLOAD}>⬇ button</a> next to Pop-out overlay. </>}It installs in a few
        seconds, just for you (no admin), with a Start menu and desktop shortcut. Windows may warn that it's unrecognised (the app
        isn't code-signed): choose <b>More info → Run anyway</b>.
      </div>
      <span className={'pill' + (st === 'connected' ? ' on' : '')}>{st === 'connected' ? 'Overlay app linked' : 'Overlay app not running'}</span>
      {!inApp && st !== 'connected' && (
        <div className="mut small" style={{ marginTop: 8 }}>Open the app and it links within a few seconds. If Chrome asks to let this site reach apps on your device, choose <b>Allow</b>.</div>
      )}
    </div>
  );
}

/** A file with what the tracker did lately, to share when something goes wrong. */
function DiagnosticsCard() {
  return (
    <div className="card">
      <h3>Something not working?</h3>
      <div className="mut small" style={{ marginBottom: 10, maxWidth: 720 }}>
        The tracker keeps a short log on this computer: once a minute how each screen reading is doing, plus session events
        and errors from the last few hours. No pictures of your game, and it never leaves your computer unless you share the file.
      </div>
      <button onClick={downloadDiag}>Save diagnostics</button>
    </div>
  );
}
