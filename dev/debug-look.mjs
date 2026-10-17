// Rolls a character look for a class in a real browser, waits for its maplestory.io frames, screenshots the stage.
//   node dev/debug-look.mjs <Class> <level> <outPrefix> [mapName]
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
const [cls = 'Hunter', level = 37, out = 'look', map = 'Line 2 <Area 1>'] = process.argv.slice(2);
const server = await createServer({ server: { port: 5183 }, logLevel: 'error' }); await server.listen();
const b = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, protocolTimeout: 1800000 });
const p = await b.newPage(); await p.setViewport({ width: 1200, height: 900 });
p.on('pageerror', e => console.log('PAGEERROR', e.message));
p.on('console', m => { if (/character|look|frames/i.test(m.text())) console.log('console:', m.text()); });
await p.goto('http://localhost:5183/');
await p.waitForFunction(() => window.met);
const look = await p.evaluate(async (cls, level, map, process_keep) => {
  const c = window.met;
  c.setIdentity({ name: 'TestChar', cls, level: +level });
  const ch = JSON.parse(localStorage.getItem('met.chars') || '{}'); if (!process_keep) delete ch.TestChar; localStorage.setItem('met.chars', JSON.stringify(ch));
  const sess = (await import('/src/core/session.ts')).newSession('TestChar', cls, +level);
  sess.paused = true;
  c.sess = sess; c.tracker = c.makeTracker(sess); c.tracker.mapCur = map; // ensureLook retries only during a session
  c.notify();
  await c.ensureLook();
  for (let k = 0; k < 600 && !c.sprites.look; k++) await new Promise(r => setTimeout(r, 1000)); // failed rolls retry every 60s
  return c.sprites.look;
}, cls, level, map, !!process.env.KEEP);
console.log('look', JSON.stringify(look));
const t0 = Date.now();
let last = '';
while (Date.now() - t0 < 25 * 60000) {
  const s = await p.evaluate(() => ({ done: window.met.sprites.done, total: window.met.sprites.total, fail: window.met.sprites.failures }));
  const k = `${s.done}/${s.total} fail=${s.fail}`;
  if (k !== last) { console.log(Math.round((Date.now() - t0) / 1000) + 's', k); last = k; }
  if (s.total && s.done === s.total) break;
  await new Promise(r => setTimeout(r, 3000));
}
const box = await p.evaluate(() => { const r = document.querySelector('.stage').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
for (let k = 0; k < 4; k++) { await p.screenshot({ path: `${out}_idle${k}.png`, clip: box }); await new Promise(r => setTimeout(r, 500)); }
await p.evaluate(() => { window.met.lastActive = Date.now() + 1e7; window.met.notify(); });
for (let k = 0; k < 8; k++) { await new Promise(r => setTimeout(r, 120)); await p.screenshot({ path: `${out}_atk${k}.png`, clip: box }); }
await b.close(); await server.close();
