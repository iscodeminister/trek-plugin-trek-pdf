'use strict';
// Renders an OpenStreetMap basemap raster for a map model's Web-Mercator view.
// Tiles are fetched server-side (egress: tile.openstreetmap.org), cached in memory,
// stitched, resampled to the target size and toned down so routes stay readable.
const { decodePng } = require('./png');

const TILE_HOST = 'tile.openstreetmap.org';
const ATTRIBUTION = '© OpenStreetMap contributors';
const USER_AGENT = 'trek-pdf/1.1 (TREK trip report plugin)';
const MAX_TILES = 48;
const CACHE_MAX = 600;
const cache = new Map(); // "z/x/y" -> Promise<raster|null>

function fetchTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key); cache.set(key, hit); // LRU touch
    return hit;
  }
  const p = (async () => {
    try {
      const res = await fetch(`https://${TILE_HOST}/${key}.png`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      return decodePng(Buffer.from(await res.arrayBuffer()));
    } catch {
      return null;
    }
  })();
  cache.set(key, p);
  p.then((r) => { if (!r) cache.delete(key); });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return p;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const j = i++; out[j] = await fn(items[j]); }
  }));
  return out;
}

/**
 * @param view  { cx, cy, k } from buildMap — Mercator centre (radians) and points per radian
 * @param w,h   map size in points;  scale: output pixels per point
 * @returns { w, h, rgb } or null when no tile could be fetched
 */
async function renderBasemap(view, w, h, scale = 2) {
  const W = Math.round(w * scale), H = Math.round(h * scale);
  const pxPerRad = view.k * scale;
  let z = Math.max(1, Math.min(18, Math.round(Math.log2((pxPerRad * 2 * Math.PI) / 256))));
  let range;
  for (;;) {
    const world = 256 * 2 ** z, f = world / (2 * Math.PI);
    const gx = (X) => (X + Math.PI) * f, gy = (Y) => (Math.PI - Y) * f;
    const x0 = gx(view.cx - w / 2 / view.k), x1 = gx(view.cx + w / 2 / view.k);
    const y0 = gy(view.cy + h / 2 / view.k), y1 = gy(view.cy - h / 2 / view.k);
    range = { z, f, x0, y0, tx0: Math.floor(x0 / 256), tx1: Math.floor(x1 / 256), ty0: Math.floor(y0 / 256), ty1: Math.floor(y1 / 256) };
    if ((range.tx1 - range.tx0 + 1) * (range.ty1 - range.ty0 + 1) <= MAX_TILES || z <= 1) break;
    z -= 1;
  }
  const n = 2 ** range.z;
  const coords = [];
  for (let ty = range.ty0; ty <= range.ty1; ty++) for (let tx = range.tx0; tx <= range.tx1; tx++) coords.push([tx, ty]);
  const tiles = await pool(coords, 6, ([tx, ty]) => (ty < 0 || ty >= n ? null : fetchTile(range.z, ((tx % n) + n) % n, ty)));
  if (!tiles.some(Boolean)) return null;

  const cols = range.tx1 - range.tx0 + 1;
  const tileAt = (tx, ty) => tiles[(ty - range.ty0) * cols + (tx - range.tx0)];
  const BG = [232, 236, 240];
  const px = (gxv, gyv, out, o) => {
    const tx = Math.floor(gxv / 256), ty = Math.floor(gyv / 256);
    const t = tx >= range.tx0 && tx <= range.tx1 && ty >= range.ty0 && ty <= range.ty1 ? tileAt(tx, ty) : null;
    if (!t) { out[o] = BG[0]; out[o + 1] = BG[1]; out[o + 2] = BG[2]; return; }
    const lx = Math.min(t.w - 1, Math.max(0, Math.floor(gxv - tx * 256))), ly = Math.min(t.h - 1, Math.max(0, Math.floor(gyv - ty * 256)));
    const i = (ly * t.w + lx) * 3;
    out[o] = t.rgb[i]; out[o + 1] = t.rgb[i + 1]; out[o + 2] = t.rgb[i + 2];
  };

  // Resample with 2×2 supersampling (cheap anti-aliasing when downscaling), then mute.
  const rgb = Buffer.alloc(W * H * 3), tmp = Buffer.alloc(3);
  const step = (range.f * 1) / pxPerRad; // tile pixels per output pixel
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        px(range.x0 + (x + sx) * step, range.y0 + (y + sy) * step, tmp, 0);
        r += tmp[0]; g += tmp[1]; b += tmp[2];
      }
      r /= 4; g /= 4; b /= 4;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const o = (y * W + x) * 3;
      // 45% desaturate, then lift toward white so coloured routes dominate.
      rgb[o] = 40 + 0.84 * (lum * 0.45 + r * 0.55);
      rgb[o + 1] = 40 + 0.84 * (lum * 0.45 + g * 0.55);
      rgb[o + 2] = 40 + 0.84 * (lum * 0.45 + b * 0.55);
    }
  }
  return { w: W, h: H, rgb };
}

module.exports = { renderBasemap, ATTRIBUTION, TILE_HOST };
