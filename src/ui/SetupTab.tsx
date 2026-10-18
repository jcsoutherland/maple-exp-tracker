import { useEffect, useRef, useState } from 'react';
import type { OcrTestRow } from '../app/controller';
import { REGION_DEFS, type RegionKey, type Schedule } from '../core/config';
import { attachSelect, type FracRect } from './selectable';
import { toast, useCtrl } from './hooks';
import { NumberInput } from './NumberInput';

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
    else { x.fillStyle = '#9097a8'; x.font = '16px system-ui'; x.fillText('Share the game window (or load a video), then click "Grab frame"', 20, 30); }
    for (const k of Object.keys(REGION_DEFS) as RegionKey[]) {
      const r = c.regions[k], d = REGION_DEFS[k];
      x.strokeStyle = d.color; x.lineWidth = k === sel ? 3 : 1.5;
      x.strokeRect(r.x * el.width, r.y * el.height, r.w * el.width, r.h * el.height);
      x.fillStyle = d.color; x.font = '11px system-ui'; x.fillText(d.label, r.x * el.width, Math.max(10, r.y * el.height - 3));
    }
    if (tmp) { x.setLineDash([4, 3]); x.strokeStyle = '#fff'; x.strokeRect(tmp.x * el.width, tmp.y * el.height, tmp.w * el.width, tmp.h * el.height); x.setLineDash([]); }
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
          <li>Click <b>Grab frame</b>. Each coloured box should cover its text; to fix one, select it in the list and drag a new box on the image.</li>
          <li>Click <b>Test OCR</b>. If a black-on-white preview is messy, adjust that region's threshold.</li>
          <li>On <b>Live</b>, check name/class/level and press <b>▶ Start session</b>. <b>⧉ Pop-out overlay</b> gives an always-on-top mini window.</li>
        </ol>
      </div>
      <div className="grid2">
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <button onClick={grab}>Grab frame</button>
            <button onClick={test} disabled={testing}>{testing ? 'Reading…' : 'Test OCR'}</button>
            <button onClick={saveFrame} title="Save the current frame as a PNG (useful for bug reports / tuning)">Save frame</button>
            <span className="sp" />
            <button className="danger" onClick={() => c.resetRegions()}>Reset regions</button>
          </div>
          <canvas ref={cv} id="setupCanvas" width={960} height={540} />
          <div className="mut small" style={{ marginTop: 6 }}>Selected: <b>{REGION_DEFS[sel].label}</b>. Drag on the image to set this region.</div>
        </div>
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
          <h3 style={{ marginTop: 16 }}>OCR test</h3>
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
          <label title="0 = never. The session resumes by itself when EXP moves again.">Auto-pause after idle (s) <NumberInput width={60} min={0} max={3600} step={5} value={c.settings.idlePauseSec} onChange={v => c.updateSettings({ idlePauseSec: v })} /></label>
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
