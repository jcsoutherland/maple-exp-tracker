// Renders class avatars (idle + attack frames) into a contact sheet PNG.
//   node dev/debug-avatar.mjs out.png [zoom] [Class] [x0 w]   (Class + crop: one class, frames cropped to columns x0..x0+w)
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
const [out = 'avatars.png', zoom = 4, only, x0 = 0, cw = 0] = process.argv.slice(2);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const server = await createServer({ server: { port: 5179 }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.goto('http://localhost:5179/');
const url = await page.evaluate(async (Z, only, x0, cw) => {
  const px = await import('/src/core/pixelart.ts');
  const looks = (only ? [only] : ['Bowman', 'Warrior', 'Magician', 'Thief', 'Beginner']).map(c => px.classAvatar(c));
  const a0 = looks[0], w = cw || a0.w, cols = 12, fw = w * Z, fh = a0.h * Z;
  const c = document.createElement('canvas'); c.width = cols * fw; c.height = looks.length * fh;
  const g = c.getContext('2d'); g.fillStyle = '#1d2029'; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingEnabled = false;
  const t = document.createElement('canvas');
  looks.forEach((a, r) => [...a.idle, ...a.attack].forEach((im, i) => {
    t.width = im.width; t.height = im.height; t.getContext('2d').putImageData(im, 0, 0);
    g.drawImage(t, x0, 0, w, im.height, i * fw, r * fh, fw, fh);
    g.strokeStyle = i < a.idle.length ? '#2e4a2e' : '#4a2e2e'; g.strokeRect(i * fw + .5, r * fh + .5, fw - 1, fh - 1);
  }));
  return c.toDataURL();
}, +zoom, only || null, +x0, +cw);
fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
await browser.close(); await server.close();
