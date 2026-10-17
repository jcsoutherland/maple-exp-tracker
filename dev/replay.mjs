// Replays a gameplay recording through the real app in headless Chrome, following the live read schedule,
// and prints every event with its video timestamp plus a summary and timing.
//
//   MAPLE_VIDEO=path/to/recording.mp4 npm run replay      (CHROME=path overrides the Chrome location)
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const VIDEO = process.env.MAPLE_VIDEO;
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
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

const server = await createServer({ plugins: [videoRoute], server: { port: 5174 }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 3600000 });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:5174/');
await page.waitForFunction(() => window.met);

const out = await page.evaluate(async () => {
  const c = window.met;
  localStorage.clear();
  const v = c.capture.video;
  v.src = '/__video.mp4';
  await new Promise(r => (v.onloadedmetadata = r));
  await v.play(); v.pause();
  c.capture.kind = 'file';
  await c.initOcr();
  c.setIdentity({ name: 'Flynny', cls: 'Hunter', level: 37 });
  await c.start();
  c.ticker.stop(); // we drive the ticks ourselves at video time
  c.ticker.set = () => undefined; // (auto-pause / resume would otherwise restart the real-time ticker)
  const sc = c.settings.schedule, log = [], tickMs = [];
  let vt = 0, lastExp = 0, next = { bars: 0, exp: 0, map: 0, ui: 0 };
  const orig = c.tracker.event.bind(c.tracker);
  c.tracker.event = (type, text) => { log.push(`${vt.toFixed(2).padStart(7)}s ${type.padEnd(6)} ${text}`); orig(type, text); };
  // log watcher at 4 Hz of video time (the live app runs ~15 Hz; 4 Hz keeps the replay quick and is still far above the line lifetime)
  const STEP = 0.25;
  // Date.now() drives the forced-read and map timers; advance a fake clock with video time
  const t0 = Date.now(); const realNow = Date.now; Date.now = () => t0 + vt * 1000;
  for (let t = 0; t < v.duration - 0.5; t += STEP) {
    vt = t; v.currentTime = t;
    await new Promise(r => (v.onseeked = r));
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 20)));
    const a = performance.now(); await c.tickLog(); tickMs.push(performance.now() - a);
    if (t >= next.bars) { next.bars = t + sc.barsMs / 1000; await c.tickBars(); }
    if (t >= next.ui) { next.ui = t + 1; c.checkIdle(); } // the app's 1 s UI tick: auto-pause after idlePauseSec
    if (t >= next.exp) { next.exp = t + sc.expMs / 1000; if (c.autoPaused) await c.watchIdle(); else await c.tickExp(); }
    if (t >= next.map) { next.map = t + 2; await c.tickMap(false); }
    const s = c.sess;
    if (s.exp !== lastExp) { log.push(`${t.toFixed(2).padStart(7)}s exp    +${s.exp - lastExp} (bar ${c.tracker.exp} @ ${c.tracker.pct}%) map=${c.tracker.mapName}`); lastExp = s.exp; }
  }
  Date.now = realNow;
  const s = c.sess, tr = c.tracker;
  tickMs.sort((a, b) => a - b);
  return {
    log,
    summary: { exp: s.exp, expLost: s.expLost, mesos: s.mesos, maps: s.maps, drops: Object.fromEntries(Object.entries(s.drops).map(([k, d]) => [k, d.qty])),
      hp: s.hp, mp: s.mp, hpMax: tr.hp.max, mpMax: tr.mp.max },
    perf: { logChecks: c.stats.logChecks, ocrCalls: c.stats.ocrCalls, logTickMedianMs: Math.round(tickMs[tickMs.length >> 1]), logTickP95Ms: Math.round(tickMs[Math.floor(tickMs.length * 0.95)]) },
  };
});
console.log(out.log.join('\n'));
console.log('\n' + JSON.stringify(out.summary, null, 1));
console.log('perf', JSON.stringify(out.perf));
await browser.close();
await server.close();
