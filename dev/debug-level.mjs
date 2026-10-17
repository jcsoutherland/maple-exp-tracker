// Level region at several video times: the regular prep vs zoom-and-enhance, both through the digit reader.
//   MAPLE_VIDEO=... node dev/debug-level.mjs outPrefix t1 t2 ...
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
const [out, ...times] = process.argv.slice(2);
const server = await createServer({ server: { port: 5189 }, logLevel: 'error' }); await server.listen();
const b = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const p = await b.newPage(); p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto('http://localhost:5189/'); await p.waitForFunction(() => window.met);
const res = await p.evaluate(async times => {
  const c = window.met; await c.initOcr();
  const img = await import('/src/core/imaging.ts'), cfg = await import('/src/core/config.ts'), parse = await import('/src/core/parse.ts');
  const v = document.createElement('video'); v.muted = true; v.src = '/__video.mp4'; document.body.append(v);
  await new Promise(r => (v.onloadedmetadata = r));
  const out = [];
  for (const t of times) {
    v.currentTime = +t; await new Promise(r => (v.onseeked = r)); await new Promise(r => setTimeout(r, 50));
    const r = c.regions.level, W = v.videoWidth, H = v.videoHeight;
    const raw = document.createElement('canvas'); raw.width = Math.round(r.w * W) * 8; raw.height = Math.round(r.h * H) * 8;
    const g = raw.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(v, r.x * W, r.y * H, r.w * W, r.h * H, 0, 0, raw.width, raw.height);
    const prep = img.prepRegion(v, r, cfg.REGION_DEFS.level), en = img.enhanceText(v, r, 6, 'min', 160);
    const a = await c.engine.read(prep.canvas, 'num'), e = await c.engine.read(en.canvas, 'num');
    out.push({ t, a, e, pa: parse.parseLevel(a), pe: parse.parseLevel(e), raw: raw.toDataURL(), prep: prep.canvas.toDataURL(), en: en.canvas.toDataURL() });
  }
  return out;
}, times);
for (const r of res) {
  for (const k of ['raw', 'prep', 'en']) fs.writeFileSync(`${out}_${r.t}_${k}.png`, Buffer.from(r[k].split(',')[1], 'base64'));
  console.log(r.t, 'regular', JSON.stringify(r.a), '->', r.pa, '| enhanced', JSON.stringify(r.e), '->', r.pe);
}
await b.close(); await server.close();
