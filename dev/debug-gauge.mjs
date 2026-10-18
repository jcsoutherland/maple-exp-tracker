// Plays a gameplay recording through the HP/MP gauge reader and prints every potion-sized rise it detects.
//   MAPLE_VIDEO=... node dev/debug-gauge.mjs [rate=2] [hpMax=1303] [mpMax=1078]
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const [rate = 2, hpMax = 1303, mpMax = 1078] = process.argv.slice(2).map(Number);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const server = await createServer({ server: { port: 5178 }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('console', m => console.log(m.text()));
await page.goto('http://localhost:5178/');
await page.evaluate(async (rate, hpMax, mpMax) => {
  const { gaugeFill } = await import('/src/core/imaging.ts');
  const { DEFAULT_REGIONS } = await import('/src/core/config.ts');
  const { Tracker } = await import('/src/core/tracker.ts');
  const { newSession } = await import('/src/core/session.ts');
  const s = newSession('x', 'Hunter', 37);
  let vt = 0;
  const t = new Tracker(s, { hpMin: () => 40, mpMin: () => 25, now: () => vt * 1000 });
  t.hp.max = hpMax; t.mp.max = mpMax;
  const v = document.createElement('video'); v.muted = true; v.src = '/__video.mp4'; document.body.append(v);
  await new Promise(r => (v.onloadedmetadata = r));
  v.playbackRate = rate;
  const seen = { hp: 0, mp: 0 }, nulls = { hp: 0, mp: 0 }, n = { hp: 0, mp: 0 };
  let next = 0, reads = 0;
  await new Promise(done => {
    const step = (_now, meta) => {
      vt = meta.mediaTime;
      if (vt >= next) { // one read per 100 ms of video, like the live schedule
        next = vt + 0.1; reads++;
        for (const k of ['hp', 'mp']) {
          const f = gaugeFill(v, DEFAULT_REGIONS[k + 'Gauge'], k);
          if (f == null) nulls[k]++;
          t.onGauge(k, f);
          const j = s[k].jumps ?? [];
          for (; n[k] < j.length; n[k]++) console.log(`${vt.toFixed(1)}s ${k.toUpperCase()} +${j[n[k]]}  (now ${f == null ? '?' : (f * 100).toFixed(0) + '%'})`);
        }
      }
      if (!v.ended) v.requestVideoFrameCallback(step); else done();
    };
    v.requestVideoFrameCallback(step);
    v.onended = done;
    v.play();
  });
  console.log(`reads ${reads} · unreadable hp ${nulls.hp} mp ${nulls.mp} · HP pots ${s.hp.jumps?.length ?? 0} · MP pots ${s.mp.jumps?.length ?? 0}`);
}, rate, hpMax, mpMax);
await browser.close(); await server.close();
