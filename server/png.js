'use strict';
// Tiny PNG codec on node:zlib: decode any non-interlaced PNG to RGB (alpha composited
// on white), encode RGB to PNG. Enough for map tiles; no dependencies.
const zlib = require('zlib');

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let p = 8, w = 0, h = 0, depth = 8, type = 2, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
    else if (kind === 'PLTE') palette = d;
    else if (kind === 'tRNS') trns = d;
    else if (kind === 'IDAT') idat.push(d);
    else if (kind === 'IEND') break;
    p += 12 + len;
  }
  if (interlace) throw new Error('interlaced PNG not supported');
  if (depth === 16) throw new Error('16-bit PNG not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = Math.ceil((w * channels * depth) / 8), bpp = Math.max(1, (channels * depth) >> 3);
  const px = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      row[i] = v & 255;
    }
    prev = row;
  }
  const rgb = Buffer.alloc(w * h * 3);
  const sample = (row, x, ch) => {
    if (depth === 8) return row[x * channels + ch];
    const bit = x * depth, byte = row[bit >> 3];
    return (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  for (let y = 0; y < h; y++) {
    const row = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < w; x++) {
      let r, g, b, a = 255;
      if (type === 3) {
        const i = sample(row, x, 0);
        r = palette[i * 3]; g = palette[i * 3 + 1]; b = palette[i * 3 + 2];
        if (trns && i < trns.length) a = trns[i];
      } else if (type === 0 || type === 4) {
        r = g = b = depth === 8 ? sample(row, x, 0) : Math.round((sample(row, x, 0) * 255) / ((1 << depth) - 1));
        if (type === 4) a = sample(row, x, 1);
      } else {
        r = row[x * channels]; g = row[x * channels + 1]; b = row[x * channels + 2];
        if (type === 6) a = row[x * channels + 3];
      }
      const o = (y * w + x) * 3;
      rgb[o] = (r * a + 255 * (255 - a)) / 255;
      rgb[o + 1] = (g * a + 255 * (255 - a)) / 255;
      rgb[o + 2] = (b * a + 255 * (255 - a)) / 255;
    }
  }
  return { w, h, rgb };
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(kind, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(kind, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng({ w, h, rgb }) {
  const stride = w * 3, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1), src = rgb.subarray(y * stride, (y + 1) * stride);
    raw[o] = 1; // Sub filter — maps compress noticeably better than with None
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (src[i] - (i >= 3 ? src[i - 3] : 0)) & 255;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { decodePng, encodePng };
