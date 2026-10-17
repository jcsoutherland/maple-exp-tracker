// Prints log line-slot geometry and frame-to-frame slot dissimilarity at given video times (dedup debugging).
//   MAPLE_VIDEO=... node dev/debug-log.mjs 189,189.25,189.5
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const VIDEO = process.env.MAPLE_VIDEO, CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TIMES = (process.argv[2] || '189,189.25,189.5,189.75,190').split(',').map(Number);
const server = await createServer({
  server: { port: 5175 }, logLevel: 'error',
  plugins: [{ name: 'v', configureServer: s => { s.middlewares.use('/__video.mp4', (req, res) => {
    const size = fs.statSync(VIDEO).size, [a, b] = (req.headers.range || 'bytes=0-').replace('bytes=', '').split('-'), start = +a, end = b ? +b : size - 1;
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    fs.createReadStream(VIDEO, { start, end }).pipe(res);
  }); } }],
});
await server.listen();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.goto('http://localhost:5175/');
await page.waitForFunction(() => window.met);
const out = await page.evaluate(async (TIMES) => {
  const im = await import('/src/core/imaging.ts');
  const c = window.met, v = c.capture.video, r = c.regions.log;
  v.src = '/__video.mp4'; await new Promise(x => (v.onloadedmetadata = x)); await v.play(); v.pause();
  const res = []; let prev = null;
  for (const t of TIMES) {
    v.currentTime = t; await new Promise(x => (v.onseeked = x)); await new Promise(x => requestAnimationFrame(() => setTimeout(x, 20)));
    const s = im.logScan(v, r, r.thr - 30, document.createElement('canvas'));
    const m = prev ? prev.slots.map((_, i) => s.slots.map((_, j) => im.slotDiff(prev, i, s, j).toFixed(2)).join(' ')) : [];
    res.push(`t=${t} slots=${JSON.stringify(s.slots)} new=${JSON.stringify(im.newLineCount(prev, s))}\n   prev-slot rows × cur-slot cols:\n   ${m.join('\n   ')}`);
    prev = s;
  }
  return res;
}, TIMES);
console.log(out.join('\n'));
await browser.close(); await server.close();
