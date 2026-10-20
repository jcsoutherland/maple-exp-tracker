// Decodes the game's quickslot count digits (UI.wz Basic.img/ItemNo 0–9, exported as PNGs in dev/sprites/itemno/)
// into src/core/data/itemno.json: per digit its size and, per pixel, the brightest channel and alpha.
//   node dev/build-itemno.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePng(buf) {
  let p = 8, w = 0, h = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); if (data[8] !== 8 || data[9] !== 6 || data[12]) throw new Error('need 8-bit RGBA'); }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), bpp = 4, stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[y * stride + x] = (src[x] + pred) & 255;
    }
  }
  return { w, h, rgba: out };
}

const digits = [];
for (let d = 0; d < 10; d++) {
  const { w, h, rgba } = decodePng(fs.readFileSync(`dev/sprites/itemno/Basic.img_ItemNo_${d}.png`));
  const v = [], a = [];
  for (let k = 0; k < w * h; k++) { v.push(Math.max(rgba[k * 4], rgba[k * 4 + 1], rgba[k * 4 + 2])); a.push(rgba[k * 4 + 3]); }
  digits.push({ w, h, v, a });
  console.log(d + '\n' + Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => (a[y * w + x] < 128 ? ' ' : v[y * w + x] > 128 ? '#' : '.')).join('')).join('\n'));
}
fs.writeFileSync('src/core/data/itemno.json', JSON.stringify(digits));
