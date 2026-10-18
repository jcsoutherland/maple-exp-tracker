// How well the pickup-log line matcher lines up consecutive frames: steps through a recording at the live 15 Hz and
// counts, per variant, the frames where no shift lines up (the matcher has to guess) and the new lines found.
//   MAPLE_VIDEO=recording.mp4 node dev/bench-lines.mjs [from=0] [to=end]
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const [from = 0, to = Infinity] = process.argv.slice(2).map(Number);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const server = await createServer({ server: { port: +(process.env.PORT || 5198) }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 3600000 });
const page = await browser.newPage();
page.on('console', m => { const t = m.text(); if (!/vite|DevTools/.test(t)) console.log(t); });
await page.goto(`http://localhost:${process.env.PORT || 5198}/`);
await page.evaluate(async (from, to) => {
  const { logScan, slotDiff } = await import('/src/core/imaging.ts');
  const { LogAnchor } = await import('/src/core/logqueue.ts');
  const { DEFAULT_REGIONS } = await import('/src/core/config.ts');
  const v = document.createElement('video'); v.muted = true; v.src = '/__video.mp4'; document.body.append(v);
  await new Promise(r => (v.onloadedmetadata = r));
  const r = DEFAULT_REGIONS.log, anchor = new LogAnchor(), end = Math.min(to, v.duration - 0.5);

  // raw-brightness correlation of two slots (fading scales brightness, which correlation ignores), ±D px vertically
  const lum = (s, x, y) => { const p = (y * s.W + x) * 4; return 0.299 * s.rgba[p] + 0.587 * s.rgba[p + 1] + 0.114 * s.rgba[p + 2]; };
  const rawDiff = (a, i, b, j) => {
    const [a0, a1] = a.slots[i], [b0, b1] = b.slots[j], h = Math.min(a1 - a0, b1 - b0), D = Math.round(2 * a.f);
    let best = 1;
    for (let dy = -D; dy <= D; dy++) {
      let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let y = 1; y < h - 1; y++) {
        const ya = a0 + y, yb = b0 + y + dy;
        if (yb < 0 || yb >= b.H) continue;
        for (let x = 0; x < a.W; x += 1) { const p = lum(a, x, ya), q = lum(b, x, yb); n++; sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q; }
      }
      const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
      if (n && va > 0 && vb > 0) best = Math.min(best, 1 - (sab - sa * sb / n) / Math.sqrt(va * vb));
    }
    return best;
  };
  // text-likeness correlation over the text's own columns only (both slots' strong-ink extent): a player or effect
  // beside the text no longer spoils the match
  const ext = (s, i) => { const [a0, a1] = s.slots[i]; let x0 = s.W, x1 = -1; for (let x = 0; x < s.W; x++) { let n = 0; for (let y = a0; y < a1; y++) if (s.sc[y * s.W + x] > 40) n++; if (n >= 2) { if (x < x0) x0 = x; x1 = x; } } return [x0, x1]; };
  const textDiff = (a, i, b, j) => {
    const [ax0, ax1] = ext(a, i), [bx0, bx1] = ext(b, j);
    if (ax1 < 0 || bx1 < 0) return 1;
    const X0 = Math.max(0, Math.min(ax0, bx0) - 2), X1 = Math.min(a.W - 1, Math.max(ax1, bx1) + 2);
    const [a0, a1] = a.slots[i], [b0, b1] = b.slots[j], h = Math.min(a1 - a0, b1 - b0), D = Math.round(2 * a.f);
    let best = 1;
    for (let dy = -D; dy <= D; dy++) {
      let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let y = 1; y < h - 1; y++) {
        const ya = a0 + y, yb = b0 + y + dy;
        if (yb < 0 || yb >= b.H) continue;
        for (let x = X0; x <= X1; x++) { const pp = a.sc[ya * a.W + x], q = b.sc[yb * b.W + x]; n++; sa += pp; sb += q; saa += pp * pp; sbb += q * q; sab += pp * q; }
      }
      const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
      if (n && va > 0 && vb > 0) best = Math.min(best, 1 - (sab - sa * sb / n) / Math.sqrt(va * vb));
    }
    return best;
  };
  const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  // the matcher with a pluggable slot difference and way of combining the compared pairs
  const count = (prev, cur, diff, agg, nmax, maxDiff) => {
    const C = cur.slots.length, P = prev?.slots.length ?? 0;
    if (!C) return { count: 0, aligned: true };
    if (!P) return { count: C, aligned: false };
    let best = -1, bestD = 1;
    for (let s = 0; s < C; s++) {
      const n = Math.min(nmax, C - s, P), ds = [];
      for (let k = 0; k < n; k++) ds.push(diff(prev, k, cur, k + s));
      const d = agg === 'median' ? med(ds) : ds.reduce((a, b) => a + b, 0) / ds.length;
      if (d < bestD - 0.02 || (Math.abs(d - bestD) <= 0.02 && s === C - P)) { if (d < bestD) bestD = d; best = s; }
    }
    return best >= 0 && bestD <= maxDiff ? { count: best, aligned: true, d: bestD } : { count: 0, aligned: false, d: bestD };
  };
  const V = {
    'V0 text-likeness, mean of 3 (now)': (p, c) => count(p, c, slotDiff, 'mean', 3, 0.35),
    'V6 text-likeness, cutoff 0.45': (p, c) => count(p, c, slotDiff, 'mean', 3, 0.45),

    'V5 text columns only, cutoff 0.45': (p, c) => count(p, c, textDiff, 'mean', 3, 0.45),
  };
  const stat = Object.fromEntries(Object.keys(V).map(k => [k, { guess: 0, lines: 0, ds: [] }]));
  let prev = null, frames = 0, nonEmpty = 0;
  for (let t = from; t < end; t += 1 / 15) {
    v.currentTime = t; await new Promise(r => (v.onseeked = r));
    const lo = logScan(v, r, r.thr - 30, document.createElement('canvas'), anchor.value);
    anchor.add(lo.detected, `${v.videoWidth}x${v.videoHeight}`);
    if (prev && anchor.value != null) {
      frames++;
      if (lo.slots.length && prev.slots.length) nonEmpty++;
      for (const [k, fn] of Object.entries(V)) { const res = fn(prev, lo); if (!res.aligned) { stat[k].guess++; stat[k].ds.push(res.d); } else stat[k].lines += res.count; }
    }
    prev = lo;
  }
  console.log(`frames compared: ${frames} (both frames with lines: ${nonEmpty})`);
  const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(f * (s.length - 1))].toFixed(2) : '-'; };
  for (const [k, s] of Object.entries(stat)) console.log(`${k.padEnd(36)} guesses ${String(s.guess).padStart(4)}   new lines when aligned ${s.lines}   guess best-match d: p25 ${q(s.ds, 0.25)} median ${q(s.ds, 0.5)} p75 ${q(s.ds, 0.75)}`);
}, from, to);
await browser.close(); await server.close();
