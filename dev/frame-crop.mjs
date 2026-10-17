// Saves a zoomed crop of a gameplay-video frame to a PNG (for measuring UI/sprite geometry).
//   MAPLE_VIDEO=... node dev/frame-crop.mjs <t> <x> <y> <w> <h> <zoom> <out.png> [grid]
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const [t, x, y, w, h, z, out, grid] = process.argv.slice(2);
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const server = await createServer({ server: { port: 5176 }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.goto('http://localhost:5176/');
const url = await page.evaluate(async (t, x, y, w, h, z, grid) => {
  const v = document.createElement('video'); v.muted = true; v.src = '/__video.mp4'; document.body.append(v);
  await new Promise(r => (v.onloadedmetadata = r)); await v.play(); v.pause();
  v.currentTime = t; await new Promise(r => (v.onseeked = r)); await new Promise(r => setTimeout(r, 300));
  const c = document.createElement('canvas'); c.width = w * z; c.height = h * z;
  const g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(v, x, y, w, h, 0, 0, c.width, c.height);
  if (grid) {
    g.strokeStyle = 'rgba(255,0,255,.55)'; g.fillStyle = '#f0f'; g.font = '11px sans-serif';
    for (let i = 0; i <= w; i += 10) { g.beginPath(); g.moveTo(i * z, 0); g.lineTo(i * z, c.height); g.stroke(); g.fillText(x + i, i * z + 2, 11); }
    for (let j = 0; j <= h; j += 10) { g.beginPath(); g.moveTo(0, j * z); g.lineTo(c.width, j * z); g.stroke(); g.fillText(y + j, 2, j * z - 2); }
  }
  return c.toDataURL();
}, +t, +x, +y, +w, +h, +z, !!grid);
fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
await browser.close(); await server.close();
