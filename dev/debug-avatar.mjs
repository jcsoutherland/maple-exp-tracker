// Builds the pixel-art avatar from a stretch of video and saves a contact sheet of every class animation.
//   MAPLE_VIDEO=... node dev/debug-avatar.mjs <from> <to> <step> <name> <outPrefix>
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
const [from = 40, to = 110, step = 0.5, name = 'Flynny', prefix = 'sprite'] = process.argv.slice(2);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const server = await createServer({ server: { port: 5179 }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 1200000 });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:5179/');
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
  const px = await import('/src/core/pixelart.ts');
  const cuts = L.idle.concat(L.attack).map(f => L.cutout(f, true)).filter(Boolean);
  if (!cuts.length) return { found, samples: L.sampleCount, mask: L.maskReady };
  const area = c => { let n = 0; for (let i = 3; i < c.data.length; i += 4) if (c.data[i] > 128) n++; return n; };
  const pick = cuts.map(c => ({ c, a: area(c) })).sort((x, y) => x.a - y.a)[cuts.length >> 1].c;
  const base = px.pixelize(pick, 48);
  const fams = ['bow', 'sword', 'wand', 'stars', 'gun', 'fist'], S = 3;
  const anims = fams.map(fm => px.buildAnimations(base, fm, 'left'));
  const cols = 9, fw = anims[0].w, fh = anims[0].h;
  const sheet = document.createElement('canvas'); sheet.width = cols * fw * S; sheet.height = (fams.length + 1) * fh * S;
  const g = sheet.getContext('2d'); g.fillStyle = '#1d2029'; g.fillRect(0, 0, sheet.width, sheet.height); g.imageSmoothingEnabled = false;
  const put = (im, cx, cy) => { const t = document.createElement('canvas'); t.width = im.width; t.height = im.height; t.getContext('2d').putImageData(im, 0, 0); g.drawImage(t, cx, cy, im.width * S, im.height * S); };
  anims[0].idle.forEach((im, i) => put(im, i * fw * S, 0));
  anims.forEach((an, r) => an.attack.forEach((im, i) => put(im, i * fw * S, (r + 1) * fh * S)));
  g.fillStyle = '#fff'; g.font = '14px sans-serif'; g.fillText('idle', 4, 16); fams.forEach((fm, r) => g.fillText(fm, 4, (r + 1) * fh * S + 16));
  return { found, samples: L.sampleCount, mask: L.maskReady, cut: sheet.toDataURL(), raw: px.imageDataToUrl(base) };
}, +from, +to, +step, name);
console.log(JSON.stringify({ ...out, cut: !!out.cut, raw: !!out.raw }));
if (out.cut) { fs.writeFileSync(prefix + '_sheet.png', Buffer.from(out.cut.split(',')[1], 'base64')); fs.writeFileSync(prefix + '_base.png', Buffer.from(out.raw.split(',')[1], 'base64')); }
await browser.close(); await server.close();
