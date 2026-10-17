// Prints what the map regions read at given video times (raw OCR → parsed/matched).
//   MAPLE_VIDEO=... node dev/debug-map.mjs 10 40 165
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
const times = process.argv.slice(2).map(Number);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const server = await createServer({ server: { port: 5180 }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.goto('http://localhost:5180/');
await page.waitForFunction(() => window.met);
const out = await page.evaluate(async times => {
  const c = window.met; await c.initOcr();
  await (await import('/src/core/data/osms.ts')).loadOsms();
  const v = document.createElement('video'); v.muted = true; v.src = '/__video.mp4'; document.body.append(v);
  await new Promise(r => (v.onloadedmetadata = r));
  const res = [];
  for (const t of times) {
    v.currentTime = t; await new Promise(r => (v.onseeked = r)); await new Promise(r => setTimeout(r, 50));
    const rows = await c.testOcr(v);
    for (const r of rows) if (r.key === 'map' || r.key === 'mapBar') res.push(`${t}s ${r.key}: raw=${JSON.stringify(r.raw)} -> ${r.parsed}`);
  }
  return res;
}, times);
console.log(out.join('\n'));
await browser.close(); await server.close();
