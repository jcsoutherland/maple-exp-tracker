// Reads the character-name region at several video times; saves the raw crop and the OCR-prepared image.
//   MAPLE_VIDEO=... node dev/debug-name.mjs outPrefix t1 t2 ...
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
const [out, ...times] = process.argv.slice(2);
const server = await createServer({ server: { port: 5185 }, logLevel: 'error' }); await server.listen();
const b = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const p = await b.newPage();
p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto('http://localhost:5185/'); await p.waitForFunction(() => window.met);
const res = await p.evaluate(async times => {
  const c = window.met; await c.initOcr();
  const img = await import('/src/core/imaging.ts'), parse = await import('/src/core/parse.ts');
  const v = document.createElement('video'); v.muted = true; v.src = '/__video.mp4'; document.body.append(v);
  await new Promise(r => (v.onloadedmetadata = r));
  const out = [];
  for (const t of times) {
    v.currentTime = +t; await new Promise(r => (v.onseeked = r)); await new Promise(r => setTimeout(r, 50));
    const r = c.regions.name, W = v.videoWidth, H = v.videoHeight;
    const raw = document.createElement('canvas'); raw.width = Math.round(r.w * W); raw.height = Math.round(r.h * H);
    raw.getContext('2d').drawImage(v, r.x * W, r.y * H, raw.width, raw.height, 0, 0, raw.width, raw.height);
    const z = document.createElement('canvas'); z.width = raw.width * 8; z.height = raw.height * 8; const g = z.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(raw, 0, 0, z.width, z.height);
    const prep = img.enhanceText(v, r);
    const rr = await c.engine.readChars(prep.canvas, 'line'), txt = rr.text;
    const name = parse.cleanName(txt); out.push({ t, raw: z.toDataURL(), prep: prep.canvas.toDataURL(), txt, name, fixed: parse.cleanName(img.fixIL(rr.chars, prep)), runs: rr.chars.map(c => c.c + '[' + c.x0 + '-' + c.x1 + ']').join(' ') });
  }
  return out;
}, times);
res.forEach((r, i) => {
  fs.writeFileSync(`${out}_${r.t}_raw.png`, Buffer.from(r.raw.split(',')[1], 'base64'));
  fs.writeFileSync(`${out}_${r.t}_prep.png`, Buffer.from(r.prep.split(',')[1], 'base64'));
  console.log(r.t, JSON.stringify(r.txt), '->', r.name, '-> fixed', r.fixed, '| runs', r.runs);
});
await b.close(); await server.close();
