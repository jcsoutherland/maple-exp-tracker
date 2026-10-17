// Steps through video frames: acquires the name tag by OCR on the first hit, then tracks it, printing box + correlation.
//   MAPLE_VIDEO=... node dev/debug-tag.mjs <from> <to> <step> <name>
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
const [from = 40, to = 60, step = 0.4, name = 'Flynny'] = process.argv.slice(2);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const server = await createServer({ server: { port: 5177 }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 600000 });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:5177/');
await page.waitForFunction(() => window.met);
const out = await page.evaluate(async (from, to, step, name) => {
  const ch = await import('/src/core/character.ts');
  const { sim } = await import('/src/core/util.ts');
  const c = window.met; await c.initOcr();
  const v = document.createElement('video'); v.muted = true; v.src = '/__video.mp4'; document.body.append(v);
  await new Promise(r => (v.onloadedmetadata = r)); await v.play(); v.pause();
  const log = []; let tr = null;
  for (let t = from; t <= to; t += step) {
    v.currentTime = t; await new Promise(r => (v.onseeked = r)); await new Promise(r => setTimeout(r, 30));
    if (!tr) {
      const cands = ch.findTagCandidates(v, undefined, 8);
      for (const b of cands) {
        const txt = (await c.engine.read(ch.tagOcrCanvas(v, b), 'line')).replace(/[^A-Za-z0-9 ]/g, '');
        log.push(`t${t.toFixed(1)} cand ${b.x},${b.y} ${b.w}x${b.h} ${txt}`);
        const tl = txt.toLowerCase().replace(/[^a-z0-9]/g, ''), nl = name.toLowerCase(); let bs = 0;
        for (let i = 0; i <= Math.max(0, tl.length - nl.length + 1); i++) for (const L of [nl.length - 1, nl.length, nl.length + 1]) bs = Math.max(bs, sim(tl.slice(i, i + L), nl));
        if (bs >= 0.6) { tr = new ch.TagTracker(b, v); log.push('  ACQUIRED'); break; }
      }
      continue;
    }
    const b = tr.locate(v) || tr.locateAnywhere(v);
    log.push(`t${t.toFixed(1)} ${b ? b.x + ',' + b.y : 'LOST'} corr ${tr.lastCorr.toFixed(2)}`);
  }
  return log;
}, +from, +to, +step, name);
console.log(out.join('\n'));
await browser.close(); await server.close();
