'use strict';
// OpenFreeMap "Positron" basemap, rendered from vector tiles into plain geometry
// (fills, strokes, labels in map-local points) that both the PDF and the tab's SVG draw.
// Tiles are fetched server-side from tiles.openfreemap.org and cached in memory.
const zlib = require('zlib');
const { decodeTile } = require('./mvt');
const { covers } = require('./font');
const raster = require('./tiles');
const { encodePng } = require('./png');

const HOST = 'tiles.openfreemap.org';
const ATTRIBUTION = 'OpenFreeMap © OpenMapTiles © OpenStreetMap';
const USER_AGENT = 'trek-pdf/1.2 (TREK trip report plugin)';
const MAX_TILES = 16;
const CACHE_BYTES = 48 * 1024 * 1024;
const LAYERS = new Set(['water', 'park', 'landcover', 'landuse', 'waterway', 'transportation', 'boundary', 'place', 'water_name', 'aeroway']);

// OpenFreeMap's five styles (openfreemap.org/styles/*), reduced to the layers this renderer
// draws and flattened onto each style's background (no alpha in the PDF).
const STYLES = {
  positron: {
    background: '#f2f3f0', water: '#c2c8ca', park: '#e6e9e5', wood: '#dce0dc', residential: '#eaeae6', ice: '#fafafa',
    waterway: '#bdcace', motorwayCasing: '#d5d5d5', motorwayInner: '#ffffff', majorCasing: '#d5d5d5', majorInner: '#ffffff',
    low: '#e3e3e1', minor: '#e0e0e0', minorCasing: null, rail: '#d9d9d9', boundary: '#b3b3b3', boundarySub: '#c9c9c9', aeroway: '#ffffff',
    label: '#000000', labelSoft: '#333333', labelSuburb: '#666666', waterLabel: '#495e91', halo: '#ffffff',
  },
  bright: {
    background: '#f8f4f0', water: '#aecfe2', park: '#d8e8c8', wood: '#d6e6c3', residential: '#f3eee9', ice: '#ffffff',
    waterway: '#a0c8f0', motorwayCasing: '#e9ac77', motorwayInner: '#ffcc88', majorCasing: '#e9ac77', majorInner: '#ffeeaa',
    low: '#f2d4b0', minor: '#ffffff', minorCasing: '#cfcdca', rail: '#bbbbbb', boundary: '#a3a1ac', boundarySub: '#b3b3b3', aeroway: '#f0ede9',
    label: '#333333', labelSoft: '#555555', labelSuburb: '#777777', waterLabel: '#495e91', halo: '#ffffff',
  },
  liberty: {
    background: '#f8f4f0', water: '#9ebdff', park: '#d8e8c8', wood: '#c4e2ac', residential: '#efe6dc', ice: '#ffffff',
    waterway: '#a0c8f0', motorwayCasing: '#e9ac77', motorwayInner: '#ffcc88', majorCasing: '#e9ac77', majorInner: '#ffeeaa',
    low: '#efc49a', minor: '#ffffff', minorCasing: '#cfcdca', rail: '#bbbbbb', boundary: '#696869', boundarySub: '#b3b3b3', aeroway: '#f0ede9',
    label: '#000000', labelSoft: '#333333', labelSuburb: '#666666', waterLabel: '#495e91', halo: '#ffffff',
  },
  dark: {
    background: '#0c0c0c', water: '#1b1b1d', park: '#1c1c1c', wood: '#202020', residential: '#0e0d0d', ice: '#1a1a1a',
    waterway: '#1b1b1d', motorwayCasing: '#3c3c3c', motorwayInner: '#000000', majorCasing: '#2c2c2c', majorInner: '#0a0a0a',
    low: '#181818', minor: '#181818', minorCasing: null, rail: '#232323', boundary: '#3b3b3b', boundarySub: '#363636', aeroway: '#161616',
    label: '#8a8a8a', labelSoft: '#737373', labelSuburb: '#5e5e5e', waterLabel: '#5b6170', halo: '#000000',
  },
  fiord: {
    background: '#45516e', water: '#38435c', park: '#4a5a69', wood: '#3f4965', residential: '#45516e', ice: '#56627e',
    waterway: '#363d57', motorwayCasing: '#59668a', motorwayInner: '#3b4359', majorCasing: '#59668a', majorInner: '#3e4760',
    low: '#57608a', minor: '#59668a', minorCasing: null, rail: '#283337', boundary: '#9ebfe8', boundarySub: '#6d8c9b', aeroway: '#4d5976',
    label: '#b5c8cf', labelSoft: '#a3b6c0', labelSuburb: '#4a8aa3', waterLabel: '#6e7da4', halo: '#152055',
  },
};
// 'osm' is the one raster style: standard OpenStreetMap tiles (see tiles.js).
const STYLE_IDS = [...Object.keys(STYLES), 'osm'];
const DEFAULT_STYLE = 'bright';

// ---------------------------------------------------------------- tile source

let tileUrl = null, tileUrlAt = 0;
async function template() {
  if (tileUrl && Date.now() - tileUrlAt < 6 * 3600e3) return tileUrl;
  const res = await fetch(`https://${HOST}/planet`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`tilejson ${res.status}`);
  const tj = await res.json();
  const url = tj.tiles && tj.tiles[0];
  if (typeof url !== 'string' || new URL(url).hostname !== HOST) throw new Error('unexpected tile URL');
  tileUrl = url; tileUrlAt = Date.now();
  return tileUrl;
}

const cache = new Map(); // key -> Promise<Buffer|null>
let cacheBytes = 0;
function fetchTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (cache.has(key)) { const hit = cache.get(key); cache.delete(key); cache.set(key, hit); return hit; }
  const p = (async () => {
    try {
      const url = (await template()).replace('{z}', z).replace('{x}', x).replace('{y}', y);
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(10000) });
      if (res.status === 204 || res.status === 404) return Buffer.alloc(0); // empty ocean tile
      if (!res.ok) return null;
      let buf = Buffer.from(await res.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      cacheBytes += buf.length;
      return buf;
    } catch { return null; }
  })();
  cache.set(key, p);
  p.then((b) => {
    if (!b) { cache.delete(key); return; }
    while (cacheBytes > CACHE_BYTES && cache.size > 1) {
      const [k, old] = cache.entries().next().value;
      cache.delete(k);
      old.then((ob) => { if (ob) cacheBytes -= ob.length; });
    }
  });
  return p;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j]); } }));
  return out;
}

// ---------------------------------------------------------------- styling

/** OpenMapTiles name field for a TREK language code. */
const NAME_LANG = { br: 'pt', gr: 'el', 'zh-TW': 'zh-Hant' };

function pickName(props, lang, pdf) {
  const l = NAME_LANG[lang] || lang;
  const cands = [props[`name:${l}`], l === 'zh-Hant' ? props['name:zh'] : null, props.name, props['name:en'], props.name_en, props['name:latin'], props.name_int];
  for (const c of cands) {
    if (typeof c !== 'string' || !c.trim()) continue;
    if (!pdf || covers(c)) return c.trim();
  }
  return null;
}

/** Line width that grows gently with zoom. */
const lw = (z, at, base, perZoom, max) => Math.min(max, Math.max(0.2, base + (z - at) * perZoom));

/**
 * Turn decoded tiles into drawing layers, painted in order.
 * Each layer: { kind: 'fill'|'line', color, width?, dash?, rings: [[ [x,y], ... ]] }
 */
function styleFeatures(tiles, z, project, C) {
  const L = {};
  const layer = (id, kind, color, width, dash) => (L[id] ||= { kind, color, width, dash, rings: [] });
  const order = [];
  const add = (id, kind, color, width, dash, rings) => {
    if (!L[id]) order.push(id);
    const l = layer(id, kind, color, width, dash);
    for (const r of rings) l.rings.push(r);
  };
  for (const t of tiles) {
    const P = (geom, closed) => project(t, geom, closed);
    const each = (name, fn) => { for (const f of (t.layers[name] && t.layers[name].features) || []) fn(f, f.props); };

    each('landcover', (f, p) => {
      if (f.type !== 3) return;
      if (p.class === 'wood' && z >= 8) add('wood', 'fill', C.wood, 0, null, P(f.geom, true));
      else if (p.class === 'ice') add('ice', 'fill', C.ice, 0, null, P(f.geom, true));
    });
    each('landuse', (f, p) => { if (f.type === 3 && p.class === 'residential' && z >= 9) add('residential', 'fill', C.residential, 0, null, P(f.geom, true)); });
    each('park', (f) => { if (f.type === 3) add('park', 'fill', C.park, 0, null, P(f.geom, true)); });
    each('water', (f, p) => { if (f.type === 3 && p.brunnel !== 'tunnel') add('water', 'fill', C.water, 0, null, P(f.geom, true)); });
    each('waterway', (f, p) => {
      if (f.type !== 2 || p.brunnel === 'tunnel') return;
      const river = p.class === 'river' || p.class === 'canal';
      if (!river && z < 12) return;
      add(river ? 'river' : 'stream', 'line', C.waterway, river ? lw(z, 8, 0.5, 0.15, 1.6) : 0.4, null, P(f.geom, false));
    });
    each('aeroway', (f) => { if (f.type === 3 && z >= 10) add('aeroway', 'fill', C.aeroway, 0, null, P(f.geom, true)); });
    each('transportation', (f, p) => {
      if (f.type !== 2) return;
      const g = P(f.geom, false), cls = p.class;
      if (cls === 'motorway') {
        if (z < 7) add('motorway_low', 'line', C.low, 0.6, null, g);
        else { add('motorway_casing', 'line', C.motorwayCasing, lw(z, 7, 1.4, 0.35, 4.5), null, g); add('motorway_inner', 'line', C.motorwayInner, lw(z, 7, 0.8, 0.3, 3.4), null, g); }
      } else if (cls === 'trunk' || cls === 'primary' || cls === 'secondary' || cls === 'tertiary') {
        const major = cls === 'trunk' || cls === 'primary';
        if (z < 11) { if (major || z >= 9) add('major_low', 'line', C.low, major ? 0.55 : 0.4, null, g); }
        else { add('major_casing', 'line', C.majorCasing, lw(z, 11, 1.4, 0.4, 4), null, g); add('major_inner', 'line', C.majorInner, lw(z, 11, 0.9, 0.35, 3), null, g); }
      } else if ((cls === 'minor' && z >= 12.5) || (cls === 'service' && z >= 14)) {
        const mw = lw(z, 12.5, 0.4, 0.25, 1.8);
        if (C.minorCasing && z >= 13) add('minor_casing', 'line', C.minorCasing, mw + 0.6, null, g);
        add('minor', 'line', C.minor, mw, null, g);
      } else if ((cls === 'rail' || cls === 'transit') && z >= 10 && p.brunnel !== 'tunnel') {
        add('rail', 'line', C.rail, 0.6, null, g);
      }
    });
    each('boundary', (f, p) => {
      if (f.type !== 2 || p.maritime === 1) return;
      if (p.admin_level === 2) add('boundary2', 'line', C.boundary, 0.8, p.disputed === 1 ? [3, 2] : null, P(f.geom, false));
      else if (p.admin_level <= 4 && z >= 5) add('boundary4', 'line', C.boundarySub, 0.5, [2, 2], P(f.geom, false));
    });
  }
  // Painter's order (Positron): ground → water → roads → boundaries.
  const PAINT = ['ice', 'residential', 'wood', 'park', 'water', 'stream', 'river', 'aeroway', 'minor_casing', 'minor', 'major_low', 'motorway_low',
    'rail', 'major_casing', 'motorway_casing', 'major_inner', 'motorway_inner', 'boundary4', 'boundary2'];
  return PAINT.filter((id) => L[id] && L[id].rings.length).map((id) => L[id]);
}

const PLACE = {
  country: { size: 9, bold: true, color: 'labelSoft', prio: 0, minZ: 0, maxZ: 7 },
  state: { size: 7, bold: false, color: 'labelSoft', prio: 4, minZ: 4.5, maxZ: 9 },
  city: { size: 8.5, bold: true, color: 'label', prio: 1, minZ: 3, maxZ: 22 },
  town: { size: 7.5, bold: false, color: 'label', prio: 2, minZ: 6.5, maxZ: 22 },
  village: { size: 6.8, bold: false, color: 'labelSoft', prio: 3, minZ: 10, maxZ: 22 },
  suburb: { size: 6.6, bold: false, color: 'labelSuburb', prio: 5, minZ: 11.5, maxZ: 22 },
  quarter: { size: 6.4, bold: false, color: 'labelSuburb', prio: 6, minZ: 13, maxZ: 22 },
  neighbourhood: { size: 6.2, bold: false, color: 'labelSuburb', prio: 7, minZ: 14, maxZ: 22 },
};

function collectLabels(tiles, z, lang, pdf, project, w, h, scale, C) {
  const out = [];
  for (const t of tiles) {
    for (const f of (t.layers.place && t.layers.place.features) || []) {
      const st = PLACE[f.props.class];
      if (!st || f.type !== 1 || z < st.minZ || z > st.maxZ) continue;
      if (f.props.class === 'city' && z < 6 && (f.props.rank || 99) > z + 3 && f.props.capital !== 2) continue;
      const text = pickName(f.props, lang, pdf);
      if (!text) continue;
      const [[pt]] = project(t, [f.geom[0]], false);
      if (!pt || pt[0] < 4 || pt[1] < 6 || pt[0] > w - 4 || pt[1] > h - 4) continue;
      const capital = f.props.capital === 2;
      out.push({ x: pt[0], y: pt[1], text, size: (st.size + (capital ? 0.5 : 0)) * scale, bold: st.bold, color: C[st.color], prio: st.prio - (capital ? 0.5 : 0) + (f.props.rank || 0) / 100 });
    }
    for (const f of (t.layers.water_name && t.layers.water_name.features) || []) {
      if (f.type !== 1) continue;
      const cls = f.props.class;
      if (!(cls === 'ocean' || cls === 'sea' || (cls === 'lake' && z >= 9) || (cls === 'bay' && z >= 8))) continue;
      const text = pickName(f.props, lang, pdf);
      if (!text) continue;
      const [[pt]] = project(t, [f.geom[0]], false);
      if (!pt || pt[0] < 4 || pt[1] < 6 || pt[0] > w - 4 || pt[1] > h - 4) continue;
      out.push({ x: pt[0], y: pt[1], text, size: (cls === 'ocean' ? 8 : 7) * scale, bold: false, color: C.waterLabel, prio: 8 });
    }
  }
  // Same name from neighbouring tiles' buffers → keep one.
  const seen = new Map();
  return out.sort((a, b) => a.prio - b.prio).filter((l) => {
    const prev = seen.get(l.text);
    if (prev && Math.hypot(prev.x - l.x, prev.y - l.y) < 60) return false;
    seen.set(l.text, l);
    return true;
  });
}

/**
 * Render the Positron basemap for a buildMap() model.
 * @param opts.lang   TREK language code for label names
 * @param opts.pdf    true → only names the bundled PDF fonts can draw
 * @param opts.style  one of STYLE_IDS (default positron)
 * @param opts.labelScale  label size multiplier
 * @param opts.measure  (text, size, bold) => width, for label collision boxes
 * @param opts.reserved  [[x0,y0,x1,y1]] boxes labels must avoid (route markers)
 * @param opts.scale  raster styles only: output pixels per point
 * @returns vector { background, halo, layers, labels, attribution } or raster
 *          { raster: { w, h, rgb }, attribution } — null when no tile loaded
 */
async function renderBasemap(model, opts = {}) {
  const { view, w, h } = model;
  if (opts.style === 'osm') {
    const img = await raster.renderRaster(view, w, h, opts.scale || 2);
    return img ? { raster: img, background: '#f2efe9', attribution: raster.ATTRIBUTION } : null;
  }
  const C = STYLES[opts.style] || STYLES[DEFAULT_STYLE];
  const viewZoom = Math.log2((view.k * 2 * Math.PI) / 512);
  let z = Math.max(0, Math.min(14, Math.floor(viewZoom + 0.35)));
  let range;
  for (;;) {
    const n = 2 ** z, f = n / (2 * Math.PI);
    const tx = (X) => (X + Math.PI) * f, ty = (Y) => (Math.PI - Y) * f;
    range = {
      z, n,
      x0: Math.floor(tx(view.cx - w / 2 / view.k)), x1: Math.floor(tx(view.cx + w / 2 / view.k)),
      y0: Math.max(0, Math.floor(ty(view.cy + h / 2 / view.k))), y1: Math.min(n - 1, Math.floor(ty(view.cy - h / 2 / view.k))),
    };
    if ((range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1) <= MAX_TILES || z === 0) break;
    z -= 1;
  }
  const coords = [];
  for (let y = range.y0; y <= range.y1; y++) for (let x = range.x0; x <= range.x1; x++) coords.push([x, y]);
  const bufs = await pool(coords, 6, ([x, y]) => fetchTile(range.z, ((x % range.n) + range.n) % range.n, y));
  if (!bufs.some(Boolean)) return null;

  const tiles = [];
  coords.forEach(([x, y], i) => {
    const b = bufs[i];
    if (!b || !b.length) return;
    try { tiles.push({ x, y, layers: decodeTile(b, LAYERS) }); } catch { /* corrupt tile → skip */ }
  });

  // tile units → map-local points, with near-duplicate points dropped.
  const scaleTile = (2 * Math.PI) / range.n;
  const project = (t, geom, closed) => {
    const ext = 4096;
    const res = [];
    for (const part of geom) {
      const pts = [];
      let lx = Infinity, ly = Infinity;
      for (const [gx, gy] of part) {
        const X = (t.x + gx / ext) * scaleTile - Math.PI, Y = Math.PI - (t.y + gy / ext) * scaleTile;
        const x = w / 2 + (X - view.cx) * view.k, y = h / 2 - (Y - view.cy) * view.k;
        if (Math.abs(x - lx) + Math.abs(y - ly) < 0.35) continue;
        pts.push([Math.round(x * 20) / 20, Math.round(y * 20) / 20]);
        lx = x; ly = y;
      }
      if (pts.length >= (closed ? 3 : 1)) res.push(pts);
    }
    return res;
  };
  // Cull whole rings that are entirely off-canvas.
  const onCanvas = (ring) => { const m = 8; return ring.some(([x, y]) => x > -m && y > -m && x < w + m && y < h + m) || ring.length > 2 && spans(ring, w, h); };
  const layers = styleFeatures(tiles, viewZoom, (t, g, closed) => project(t, g, closed).filter(onCanvas), C);

  const measure = opts.measure || ((s, size) => s.length * size * 0.55);
  const boxes = (opts.reserved || []).slice();
  const labels = [];
  for (const l of collectLabels(tiles, viewZoom, opts.lang || 'en', !!opts.pdf, (t, g) => project(t, g, false), w, h, opts.labelScale || 1, C)) {
    const tw = measure(l.text, l.size, l.bold);
    const box = [l.x - tw / 2 - 2, l.y - l.size * 0.85, l.x + tw / 2 + 2, l.y + l.size * 0.35];
    if (box[0] < 2 || box[2] > w - 2) continue;
    if (boxes.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
    boxes.push(box);
    labels.push({ ...l, y: l.y + l.size * 0.3 });
  }
  return { background: C.background, halo: C.halo, layers, labels, attribution: ATTRIBUTION };
}

/** A big polygon whose vertices are all off-canvas can still cover it (e.g. a sea). */
function spans(ring, w, h) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return x0 < w && x1 > 0 && y0 < h && y1 > 0;
}

/** SVG path data for the tab (keeps the JSON small); raster styles become a PNG data URL. */
function toSvg(base) {
  if (base.raster) return { image: 'data:image/png;base64,' + encodePng(base.raster).toString('base64'), background: base.background, attribution: base.attribution };
  const d = (rings, closed) => rings.map((r) => 'M' + r.map(([x, y]) => `${x} ${y}`).join('L') + (closed ? 'Z' : '')).join('');
  return {
    background: base.background,
    halo: base.halo,
    attribution: base.attribution,
    layers: base.layers.map((l) => ({ kind: l.kind, color: l.color, width: l.width, dash: l.dash, d: d(l.rings, l.kind === 'fill') })),
    labels: base.labels.map(({ x, y, text, size, bold, color }) => ({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, text, size, bold, color })),
  };
}

module.exports = { renderBasemap, toSvg, ATTRIBUTION, HOST, STYLE_IDS, STYLES, DEFAULT_STYLE };
