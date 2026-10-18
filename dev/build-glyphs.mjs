// Builds the quickslot digit templates (GLYPHS in src/core/potcount.ts) from labelled frames of a gameplay recording,
// then checks the reader against every labelled frame.
//   MAPLE_VIDEO=partymsclassicqa.mp4 node dev/build-glyphs.mjs          (prints the GLYPHS array and the check)
// The labels below are the counts on the Orange (slot 5), Red (slot 6) and Blue (slot 10) potions of that recording,
// read by eye every 10 s; QS is its quickslot box.
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const QS = { x: 0.6875, y: 0.7769, w: 0.1042, h: 0.1315, thr: 140 }, SLOTS = [5, 6, 10];
const L = {
  0: [69, 243, 220], 10: [69, 243, 220], 20: [70, 243, 220], 30: [70, 243, 220], 40: [70, 242, 220], 50: [70, 242, 220], 60: [70, 242, 220],
  70: [71, 242, 220], 80: [70, 242, 220], 90: [70, 242, 220], 100: [70, 242, 220], 110: [70, 242, 220], 120: [70, 242, 220], 130: [70, 242, 220],
  140: [71, 242, 220], 150: [71, 242, 220], 160: [71, 242, 220], 170: [72, 242, 220], 180: [72, 241, 220], 190: [72, 241, 220], 200: [72, 241, 220],
  210: [72, 241, 220], 220: [71, 241, 220], 230: [71, 241, 220], 240: [71, 241, 220], 250: [71, 241, 220], 260: [71, 241, 219], 270: [71, 241, 219],
  280: [71, 240, 219], 290: [71, 240, 219], 300: [70, 238, 218], 310: [69, 238, 219], 320: [69, 238, 218], 330: [69, 238, 218], 340: [69, 238, 218],
  350: [69, 237, 217], 360: [69, 237, 217], 370: [69, 237, 216], 380: [70, 236, 216], 390: [70, 236, 216], 400: [70, 236, 215], 410: [70, 235, 215],
  420: [70, 234, 214], 430: [71, 234, 214], 440: [70, 234, 214], 450: [70, 233, 213], 460: [70, 233, 213], 470: [70, 233, 213],
};
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const server = await createServer({ server: { port: +(process.env.PORT || 5199) }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 3600000 });
const page = await browser.newPage();
page.on('console', m => { const t = m.text(); if (!/vite|DevTools/.test(t)) console.log(t); });
await page.goto(`http://localhost:${process.env.PORT || 5199}/`);
await page.evaluate(async (QS, SLOTS, L) => {
  const pc = await import('/src/core/potcount.ts');
  const { TW, TH, advance, slotGrey, windowAt, ncc, readCount } = pc;
  const v = document.createElement('video'); v.muted = true; v.src = '/__video.mp4'; document.body.append(v);
  await new Promise(r => (v.onloadedmetadata = r));
  const samples = []; // { s: canonical slot, digits }
  for (const [t, counts] of Object.entries(L)) {
    v.currentTime = +t + 0.5; await new Promise(r => (v.onseeked = r)); await new Promise(r => setTimeout(r, 60));
    SLOTS.forEach((i, k) => samples.push({ s: slotGrey(v, QS, i, 4, 3), digits: String(counts[k]).split('').map(Number), t: +t, i }));
  }
  // digit windows of a sample when its first digit sits at (x, y)
  // the digits of a sample when its first digit sits at (x, y): once templates exist, each later digit takes its best
  // spot within ±2 px of where the previous one's advance puts it (the measured gaps then become the advances)
  let adv = [10, 5, 10, 10, 10, 10, 10, 10, 10, 10];
  const place = (sm, x, y) => {
    const out = [];
    sm.digits.forEach((d, k) => {
      let bx = x, by = y;
      if (glyphs && k > 0) { const g = glyphs[Math.min(k, 2)][d]; let bs = -2; for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) { const sc = ncc(windowAt(sm.s, x + dx, y + dy), g.mean, g.w); if (sc > bs) { bs = sc; bx = x + dx; by = y + dy; } } }
      out.push([d, bx, by]); x = bx + adv[d]; y = by;
    });
    return out;
  };
  const wins = (sm, x, y) => place(sm, x, y).map(([d, bx, by], k) => [d, windowAt(sm.s, bx, by), Math.min(k, 2)]);
  let pos = samples.map(() => [1, 26]), glyphs = null;
  for (let round = 0; round < 6; round++) {
    // sets 0..2 = digit position, 3 = all positions pooled
    const mk = () => Array.from({ length: 10 }, () => ({ s: new Float64Array(TW * TH), q: new Float64Array(TW * TH), n: 0 }));
    const acc = [mk(), mk(), mk(), mk()];
    samples.forEach((sm, k) => { for (const [d, w, ps] of wins(sm, ...pos[k])) for (const a of [acc[ps][d], acc[3][d]]) { w.forEach((p, j) => { a.s[j] += p; a.q[j] += p * p; }); a.n++; } });
    // weight: 1 where the digit looks the same in every sample, falling off where the background shows through
    const tmpl = a => {
      const mean = Array.from(a.s, p => p / a.n);
      const w = mean.map((m, j) => { const sd = Math.sqrt(Math.max(0, a.q[j] / a.n - m * m)); return +Math.min(1, (35 / Math.max(35, sd)) ** 2).toFixed(2); });
      return { mean: mean.map(Math.round), w };
    };
    const n = acc[3].map(a => a.n);
    glyphs = [0, 1, 2].map(ps => acc[ps].map((a, d) => (a.n >= 3 ? tmpl(a) : tmpl(acc[3][d]))));
    if (round === 0) console.log('per position', [0, 1, 2].map(ps => acc[ps].map(a => a.n).join(',')).join(' | '));
    if (round === 0) console.log('samples per digit', n.join(' '));
    // advances: the median gap measured after each digit
    if (round > 0) {
      const gaps = Array.from({ length: 10 }, () => []);
      samples.forEach((sm, k) => { const pl = place(sm, ...pos[k]); for (let j = 0; j + 1 < pl.length; j++) gaps[pl[j][0]].push(pl[j + 1][1] - pl[j][1]); });
      adv = adv.map((a, d) => { const g = gaps[d].sort((x, y) => x - y); return g.length ? g[g.length >> 1] : a; });
      console.log('advances', adv.join(' '));
    }
    // realign every sample to the averages
    pos = samples.map(sm => {
      let best = [1, 26], bs = -1;
      for (let y = 23; y <= 29; y++) for (let x = 0; x <= 4; x++) { const sc = wins(sm, x, y).reduce((a, [d, w, ps]) => a + ncc(w, glyphs[ps][d].mean, glyphs[ps][d].w), 0); if (sc > bs) { bs = sc; best = [x, y]; } }
      return best;
    });
  }
  // check: read every labelled slot with the finished templates
  let ok = 0, bad = [];
  for (const sm of samples) {
    const r = readCount(sm.s, glyphs, adv), want = +sm.digits.join('');
    if (r && r.value === want) ok++; else bad.push(`${sm.t}s slot${sm.i}: read ${r ? r.value + ' (' + r.score.toFixed(2) + ')' : 'nothing'}, is ${want}`);
  }
  console.log(`check: ${ok}/${samples.length} read right`); bad.forEach(b => console.log('  ' + b));
  // in between the labels (every 2.5 s): the reads should only ever step by a few
  const seq = SLOTS.map(() => []);
  for (let t = 1; t < v.duration - 1; t += 2.5) {
    v.currentTime = t; await new Promise(r => (v.onseeked = r)); await new Promise(r => setTimeout(r, 40));
    SLOTS.forEach((i, k) => { const r = readCount(slotGrey(v, QS, i, 4, 3), glyphs, adv); seq[k].push(r ? r.value : '?'); });
  }
  SLOTS.forEach((i, k) => console.log(`slot ${i}: ${seq[k].join(' ')}`));
  console.log('ADVANCE=' + JSON.stringify(adv));
  console.log('GLYPHS=' + JSON.stringify(glyphs));
  const z = 8, cv = document.createElement('canvas'); cv.width = 10 * (TW * z + 6); cv.height = 6 * (TH * z + 6);
  const g = cv.getContext('2d'); g.fillStyle = '#f0f'; g.fillRect(0, 0, cv.width, cv.height);
  const put = (arr, col, row) => { for (let j = 0; j < TH; j++) for (let i = 0; i < TW; i++) { const v = Math.round(arr[j * TW + i]); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(col * (TW * z + 6) + i * z, row * (TH * z + 6) + j * z, z, z); } };
  glyphs[2].forEach((gl, d) => { put(gl.mean, d, 0); put(gl.w.map(x => x * 255), d, 1); });
  // the three digits of red 242 @ 40 s, 243 @ 0 s, blue 213 @ 450 s, 218 @ 330 s
  const pick = (t, i) => samples.findIndex(sm => sm.t === t && sm.i === i);
  [[40, 6], [0, 6], [450, 10], [330, 10]].forEach(([t, i], r) => { const k = pick(t, i); wins(samples[k], ...pos[k]).forEach(([, w], c) => put(w, c, 2 + r)); });
  window.__png = cv.toDataURL();
}, QS, SLOTS, L);
if (process.env.PNG) { const fs = await import('node:fs'); const u = await page.evaluate(() => window.__png); fs.writeFileSync(process.env.PNG, Buffer.from(u.split(',')[1], 'base64')); }
await browser.close(); await server.close();
