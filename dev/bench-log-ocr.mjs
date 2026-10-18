// Compares ways of feeding pickup-log lines to the OCR, on real lines from a gameplay recording: how many read as a
// complete, parseable line (and with what confidence / speed).
//   MAPLE_VIDEO=recording.mp4 node dev/bench-log-ocr.mjs [maxLines=300] [step=1]
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const [maxLines = 300, step = 1] = process.argv.slice(2).map(Number);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const server = await createServer({ server: { port: +(process.env.PORT || 5199) }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 3600000 });
const page = await browser.newPage();
page.on('console', m => { const t = m.text(); if (!/vite|DevTools|onnxruntime/.test(t)) console.log(t); });
await page.goto(`http://localhost:${process.env.PORT || 5199}/`);
await page.evaluate(async (maxLines, step) => {
  const { logScan } = await import('/src/core/imaging.ts');
  const { snapLine, snapCanvas, snapExtent } = await import('/src/core/logqueue.ts');
  const { DEFAULT_REGIONS } = await import('/src/core/config.ts');
  const { lineQuality } = await import('/src/core/parse.ts');
  const { PaddleEngine } = await import('/src/core/ocr/paddle.ts');
  const pad = new PaddleEngine(); await pad.init();
  const v = document.createElement('video'); v.muted = true; v.src = '/__video.mp4'; document.body.append(v);
  await new Promise(r => (v.onloadedmetadata = r));
  const r = DEFAULT_REGIONS.log, W = v.videoWidth, Hf = v.videoHeight, X = Math.round(r.x * W), Y = Math.round(r.y * Hf);

  // collect real (non-yellow, long, right-aligned) lines as raw crops with their geometry
  const lines = [];
  for (let t = 2; t < v.duration - 1 && lines.length < maxLines; t += step) {
    v.currentTime = t; await new Promise(r => (v.onseeked = r)); await new Promise(r => setTimeout(r, 40));
    const lo = logScan(v, r, r.thr - 30, document.createElement('canvas'));
    lo.slots.forEach((sl, i) => {
      if (lo.yellow[i] || lines.length >= maxLines) return;
      const sn = snapLine(lo, null, sl, 0), e = snapExtent(sn);
      if (!e || e.x1 - e.x0 < 0.3 || Math.abs(e.x1 - 0.96) > 0.025) return;
      // keep a frame copy of the region so every variant crops the same pixels
      const c = document.createElement('canvas'); c.width = lo.W; c.height = lo.H;
      c.getContext('2d').drawImage(v, X, Y, lo.W, lo.H, 0, 0, lo.W, lo.H);
      lines.push({ t, sl, e, region: c, bin: snapCanvas(sn), f: lo.f, W: lo.W, H: lo.H });
    });
  }
  console.log(`lines: ${lines.length}`);
  const crop = (L, vpad, xcrop) => {
    const p = Math.round(vpad * L.f), a = Math.max(0, L.sl[0] - p), z = Math.min(L.H, L.sl[1] + p);
    const x0 = xcrop ? Math.max(0, Math.floor(L.e.x0 * L.W) - Math.round(6 * L.f)) : 0, x1 = xcrop ? Math.min(L.W, Math.ceil(0.96 * L.W) + Math.round(6 * L.f)) : L.W;
    const c = document.createElement('canvas'); c.width = x1 - x0; c.height = z - a;
    c.getContext('2d').drawImage(L.region, x0, a, x1 - x0, z - a, 0, 0, x1 - x0, z - a);
    return c;
  };
  const variants = {
    'A raw, full width, tight rows': L => [crop(L, 0, false), 48],
    'B raw + 2px margin above/below': L => [crop(L, 2, false), 48],
    'C B + cropped to the text': L => [crop(L, 2, true), 48],
    'D C at height 32': L => [crop(L, 2, true), 32],
    'F thresholded (old)': L => [L.bin, 48],
  };
  for (const [name, mk] of Object.entries(variants)) {
    let good = 0, conf = 0, ms = 0;
    for (const L of lines) {
      const [cv, h] = mk(L), a = performance.now(), res = await pad.readLine(cv, 'line', h);
      ms += performance.now() - a; conf += res.conf;
      if (lineQuality(res.text) >= 2) good++;
    }
    console.log(`${name.padEnd(34)} complete ${(100 * good / lines.length).toFixed(1)}%  conf ${(conf / lines.length).toFixed(3)}  ${(ms / lines.length).toFixed(0)} ms/line`);
  }
}, maxLines, step);
await browser.close(); await server.close();
