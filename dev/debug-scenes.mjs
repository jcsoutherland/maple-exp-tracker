// Renders every character backdrop into one PNG.   node dev/debug-scenes.mjs out.png
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
const [out = 'scenes.png'] = process.argv.slice(2);
const server = await createServer({ server: { port: 5182 }, logLevel: 'error' }); await server.listen();
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:5182/');
const url = await page.evaluate(async () => {
  const s = await import('/src/core/scene.ts');
  const th = ['field', 'island', 'forest', 'cliffs', 'city', 'subway', 'harbor', 'cave', 'plain'], Z = 2, cols = 3;
  const c = document.createElement('canvas'); c.width = cols * s.SCENE_W * Z; c.height = Math.ceil(th.length / cols) * s.SCENE_H * Z;
  const g = c.getContext('2d'); g.imageSmoothingEnabled = false; const t = document.createElement('canvas'); t.width = s.SCENE_W; t.height = s.SCENE_H;
  th.forEach((name, i) => { t.getContext('2d').putImageData(s.sceneImage(name), 0, 0); g.drawImage(t, (i % cols) * s.SCENE_W * Z, Math.floor(i / cols) * s.SCENE_H * Z, s.SCENE_W * Z, s.SCENE_H * Z); g.fillStyle = '#fff'; g.font = '12px sans-serif'; g.fillText(name, (i % cols) * s.SCENE_W * Z + 4, Math.floor(i / cols) * s.SCENE_H * Z + 14); });
  return c.toDataURL();
});
fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
await browser.close(); await server.close();
