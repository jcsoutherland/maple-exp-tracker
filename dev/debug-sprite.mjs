// Tracks the name tag over a stretch of video, feeds the SpriteLearner, and saves the learned cut-out + mask.
//   MAPLE_VIDEO=... node dev/debug-sprite.mjs <from> <to> <step> <name> <outPrefix>
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
const [from = 40, to = 110, step = 0.5, name = 'Flynny', prefix = 'sprite'] = process.argv.slice(2);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const server = await createServer({ server: { port: 5178 }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 1200000 });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:5178/');
await page.waitForFunction(() => window.met);
const out = await page.evaluate(async (from, to, step, name) => {
  const ch = await import('/src/core/character.ts');
  const c = window.met; await c.initOcr();
  const v = document.createElement('video'); v.muted = true; v.src = '/__video.mp4'; document.body.append(v);
  await new Promise(r => (v.onloadedmetadata = r)); await v.play(); v.pause();
  await (await import('/src/core/data/osms.ts')).loadOsms();
  const L = new ch.SpriteLearner(); let fake = 0, found = 0;
  for (let t = from; t <= to; t += step) {
    v.currentTime = t; await new Promise(r => (v.onseeked = r)); await new Promise(r => setTimeout(r, 30));
    // drive the real controller's tag logic
    c.identity.name = name;
    let b = c.tag ? c.tag.locate(v) : null;
    if (!b && c.tag) b = c.tag.locateAnywhere(v);
    if (!b && !c.tag) b = await c.acquireTag(v, name);
    if (b && c.tagCheck) { c.tagCheck.next = 0; await c.confirmTag(v, b, name); if (c.tagCheck || !c.tag) b = null; }
    if (!b) continue;
    found++;
    const sb = ch.spriteBox(v, b.x + b.w / 2, b.y); if (!sb) continue;
    fake += step * 1000;
    L.add(ch.grabBox(v, sb, document.createElement('canvas')), { x: b.x, y: b.y }, false, 1e12 + fake);
  }
  const fr = L.idle[L.idle.length - 1];
  const res = { found, samples: L.sampleCount, mask: L.maskReady, share: L.lastShare };
  if (fr) {
    res.cut = ch.toDataUrl(L.render(fr), 3);
    res.raw = ch.toDataUrl(fr.data, 3);
  }
  return res;
}, +from, +to, +step, name);
console.log(JSON.stringify({ ...out, cut: !!out.cut, raw: !!out.raw }));
if (out.cut) { fs.writeFileSync(prefix + '_cut.png', Buffer.from(out.cut.split(',')[1], 'base64')); fs.writeFileSync(prefix + '_raw.png', Buffer.from(out.raw.split(',')[1], 'base64')); }
await browser.close(); await server.close();
