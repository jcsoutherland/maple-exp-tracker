// Replays a gameplay recording through the real app in headless Chrome, following the live read schedule,
// and prints every event with its video timestamp plus a summary and timing.
//
//   MAPLE_VIDEO=path/to/recording.mp4 npm run replay      (CHROME=path overrides the Chrome location)
//   LOG_HZ=15          log-watch rate in video time (default 4; the live app runs ~15)
//   HOTBAR='{"5":"Orange Potion","6":"Red Potion","10":"Blue Potion"}'   potions on the quickslot (slot index row by row)
//   REGIONS='{"quickslot":{"x":0.6885,"y":0.7778,"w":0.1021,"h":0.1296,"thr":140}}'   region overrides
//   UI_RATIO=ideal     the game's UI ratio setting (default: default); REGIONS then overrides that ratio's boxes
//   LEVEL=38 CLASS=Hunter PORT=5174   the character at the start, dev server port
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const VIDEO = process.env.MAPLE_VIDEO;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!VIDEO || !fs.existsSync(VIDEO)) { console.error('Set MAPLE_VIDEO to a gameplay recording (.mp4)'); process.exit(1); }

// dev-only route: /__video.mp4 with Range support so the page can seek
const videoRoute = {
  name: 'replay-video',
  configureServer(server) {
    server.middlewares.use('/__video.mp4', (req, res) => {
      const size = fs.statSync(VIDEO).size, range = req.headers.range;
      if (range) {
        const [s, e] = range.replace('bytes=', '').split('-'), start = +s, end = e ? +e : size - 1;
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
        fs.createReadStream(VIDEO, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes' });
        fs.createReadStream(VIDEO).pipe(res);
      }
    });
  },
};

const server = await createServer({ plugins: [videoRoute], server: { port: +(process.env.PORT || 5174) }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 3600000 });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto(`http://localhost:${process.env.PORT || 5174}/`);
await page.waitForFunction(() => window.met);

const out = await page.evaluate(async (speed, opt) => {
  const c = window.met;
  localStorage.clear();
  const v = c.capture.video;
  v.src = '/__video.mp4';
  await new Promise(r => (v.onloadedmetadata = r));
  await v.play(); v.pause();
  c.capture.kind = 'file';
  await c.initOcr();
  c.setUiRatio(opt.uiRatio);
  for (const [k, r] of Object.entries(opt.regions)) c.setRegion(k, r);
  if (Object.keys(opt.hotbar).length) c.updateSettings({ hotbar: Array.from({ length: 12 }, (_, i) => opt.hotbar[i] ?? null) });
  c.setIdentity({ name: 'Flynny', cls: opt.cls, level: opt.level });
  await c.start();
  c.ticker.stop(); // we drive the ticks ourselves at video time
  c.ticker.set = () => undefined; // (auto-pause / resume would otherwise restart the real-time ticker)
  const sc = c.settings.schedule, log = [], tickMs = [];
  let vt = 0, lastExp = 0, next = { bars: 0, exp: 0, map: 0, ui: 0, gauge: 0 };
  // diagnostics (DIAG=out.json): every line the OCR returned and every line counted, with video time
  const ocrLines = [], countedLines = [], skipped = [];
  const { snapExtent } = await import('/src/core/logqueue.ts');
  c.debug = (kind, info) => skipped.push([+vt.toFixed(2), kind, info && info.lo ? (e => (e ? e.x0.toFixed(2) + '-' + e.x1.toFixed(2) : '-'))(snapExtent(info)) : info ?? '']);
  const read0 = c.engine.read.bind(c.engine);
  c.engine.read = async (cv, kind) => { const t = await read0(cv, kind); if (kind === 'line') ocrLines.push([+vt.toFixed(2), t]); return t; };
  if (c.logEngine !== c.engine) { const lr0 = c.logEngine.read.bind(c.logEngine); c.logEngine.read = async (cv, kind) => { const t = await lr0(cv, kind); ocrLines.push([+vt.toFixed(2), t]); return t; }; }
  if (opt.logOcr === 'tesseract') c.logEngine = c.engine; // LOG_OCR=tesseract: compare with the old reader
  const lines0 = c.tracker.onLogLines.bind(c.tracker);
  c.tracker.onLogLines = ls => { ls.forEach(l => countedLines.push([+vt.toFixed(2), l])); lines0(ls); };
  const orig = c.tracker.event.bind(c.tracker);
  c.tracker.event = (type, text) => { log.push(`${vt.toFixed(2).padStart(7)}s ${type.padEnd(6)} ${text}`); orig(type, text); };
  // log watcher at LOG_HZ of video time (the live app runs ~15 Hz; 4 Hz is quicker and enough for a solo log)
  const STEP = 1 / opt.logHz;
  // Date.now() drives the forced-read and map timers; advance a fake clock with video time
  const t0 = Date.now(); const realNow = Date.now; Date.now = () => t0 + vt * 1000;
  const wall0 = performance.now(), SPEED = speed; // SPEED > 1 plays the video faster, simulating a busier (party) log
  for (let t = 0; t < v.duration - 0.5; t += STEP) {
    // play back in real time at most: the OCR workers read in the background at their real speed, as live
    const ahead = t * 1000 / SPEED - (performance.now() - wall0);
    if (ahead > 0) await new Promise(r => setTimeout(r, ahead));
    vt = t; v.currentTime = t;
    await new Promise(r => (v.onseeked = r));
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 20)));
    const a = performance.now(); await c.tickLog(); tickMs.push(performance.now() - a);
    if (t >= next.bars) { next.bars = t + sc.barsMs / 1000; await c.tickBars(); }
    if (t >= next.gauge) { next.gauge = t + sc.gaugeMs / 1000; c.tickGauge(); } // HP/MP gauges + hotbar slots (potions)
    if (t >= next.ui) { next.ui = t + 1; c.checkIdle(); } // the app's 1 s UI tick: auto-pause after idlePauseSec
    if (t >= next.exp) { next.exp = t + sc.expMs / 1000; if (c.autoPaused) await c.watchIdle(); else await c.tickExp(); }
    if (t >= next.map) { next.map = t + 2; await c.tickMap(false); }
    const s = c.sess;
    if (s.exp !== lastExp) { log.push(`${t.toFixed(2).padStart(7)}s exp    +${s.exp - lastExp} (bar ${c.tracker.exp} @ ${c.tracker.pct}%) map=${c.tracker.mapName}`); lastExp = s.exp; }
  }
  // log lines are read in the background from a queue: let it drain
  for (let k = 0; k < 600 && (c.reading || c.logQueue?.length); k++) await new Promise(r => setTimeout(r, 50));
  Date.now = realNow;
  const s = c.sess, tr = c.tracker;
  tickMs.sort((a, b) => a - b);
  return {
    log, ocrLines, countedLines, skipped,
    summary: { exp: s.exp, expLost: s.expLost, mesos: s.mesos, maps: s.maps, drops: Object.fromEntries(Object.entries(s.drops).map(([k, d]) => [k, d.qty])),
      hp: s.hp, mp: s.mp, hpMax: tr.hp.max, mpMax: tr.mp.max },
    perf: { logChecks: c.stats.logChecks, ocrCalls: c.stats.ocrCalls, expSkipped: c.stats.expSkipped, guessSkipped: c.stats.guessSkipped, logGuesses: c.stats.logGuesses, junkSkipped: c.stats.junkSkipped, logDropped: c.stats.logDropped, logTickMedianMs: Math.round(tickMs[tickMs.length >> 1]), logTickP95Ms: Math.round(tickMs[Math.floor(tickMs.length * 0.95)]) },
  };
}, +(process.env.SPEED || 1), {
  logHz: +(process.env.LOG_HZ || 4), hotbar: JSON.parse(process.env.HOTBAR || '{}'), regions: JSON.parse(process.env.REGIONS || '{}'), uiRatio: process.env.UI_RATIO || 'default',
  level: +(process.env.LEVEL || 37), cls: process.env.CLASS || 'Hunter', logOcr: process.env.LOG_OCR || 'paddle',
});
console.log(out.log.join('\n'));
if (process.env.DIAG) fs.writeFileSync(process.env.DIAG, JSON.stringify({ ocr: out.ocrLines, counted: out.countedLines, skipped: out.skipped }));
console.log('\n' + JSON.stringify(out.summary, null, 1));
console.log('perf', JSON.stringify(out.perf));
await browser.close();
await server.close();
