'use strict';
// Minimal TrueType (glyf) reader + subsetter for embedding as a PDF CIDFontType2.
// Glyph ids are preserved (unused glyphs are emptied), so CIDToGIDMap stays /Identity.
const fs = require('fs');
const path = require('path');

class TTFont {
  constructor(buf, name) {
    this.buf = buf;
    this.name = name;
    const n = buf.readUInt16BE(4);
    this.tables = {};
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      this.tables[buf.toString('latin1', o, o + 4)] = { offset: buf.readUInt32BE(o + 8), length: buf.readUInt32BE(o + 12) };
    }
    const head = this.t('head');
    this.unitsPerEm = buf.readUInt16BE(head + 18);
    this.bbox = [0, 2, 4, 6].map((d) => buf.readInt16BE(head + 36 + d));
    this.longLoca = buf.readInt16BE(head + 50) === 1;
    const hhea = this.t('hhea');
    this.ascent = buf.readInt16BE(hhea + 4);
    this.descent = buf.readInt16BE(hhea + 6);
    this.numHMetrics = buf.readUInt16BE(hhea + 34);
    this.numGlyphs = buf.readUInt16BE(this.t('maxp') + 4);
    this._cmap();
    this._advCache = new Map();
  }

  t(tag) {
    const e = this.tables[tag];
    if (!e) throw new Error(`font ${this.name}: missing ${tag} table`);
    return e.offset;
  }

  _cmap() {
    const b = this.buf, base = this.t('cmap');
    const subs = [];
    for (let i = 0; i < b.readUInt16BE(base + 2); i++) {
      const r = base + 4 + i * 8;
      subs.push({ pid: b.readUInt16BE(r), eid: b.readUInt16BE(r + 2), off: base + b.readUInt32BE(r + 4) });
    }
    const pick = (fmt) => subs.find((s) => b.readUInt16BE(s.off) === fmt && ((s.pid === 3 && (s.eid === 10 || s.eid === 1)) || s.pid === 0));
    const s12 = pick(12), s4 = pick(4);
    if (s12) {
      const n = b.readUInt32BE(s12.off + 12);
      this.groups = new Uint32Array(n * 3);
      for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) this.groups[i * 3 + j] = b.readUInt32BE(s12.off + 16 + i * 12 + j * 4);
    } else if (s4) {
      this.fmt4 = s4.off;
    } else throw new Error(`font ${this.name}: no usable cmap`);
  }

  /** Glyph id for a code point (0 = .notdef). */
  gid(cp) {
    const b = this.buf;
    if (this.groups) {
      const g = this.groups;
      let lo = 0, hi = g.length / 3 - 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (cp < g[m * 3]) hi = m - 1;
        else if (cp > g[m * 3 + 1]) lo = m + 1;
        else return g[m * 3 + 2] + (cp - g[m * 3]);
      }
      return 0;
    }
    if (cp > 0xffff) return 0;
    const o = this.fmt4, seg = b.readUInt16BE(o + 6) / 2;
    const ends = o + 14, starts = ends + seg * 2 + 2, deltas = starts + seg * 2, ranges = deltas + seg * 2;
    for (let i = 0; i < seg; i++) {
      if (cp > b.readUInt16BE(ends + i * 2)) continue;
      const start = b.readUInt16BE(starts + i * 2);
      if (cp < start) return 0;
      const delta = b.readInt16BE(deltas + i * 2), ro = b.readUInt16BE(ranges + i * 2);
      if (!ro) return (cp + delta) & 0xffff;
      const gi = b.readUInt16BE(ranges + i * 2 + ro + (cp - start) * 2);
      return gi ? (gi + delta) & 0xffff : 0;
    }
    return 0;
  }

  has(cp) { return this.gid(cp) !== 0; }

  /** Advance width in 1/1000 em. */
  advance(gid) {
    let w = this._advCache.get(gid);
    if (w === undefined) {
      const i = Math.min(gid, this.numHMetrics - 1);
      w = Math.round((this.buf.readUInt16BE(this.t('hmtx') + i * 4) * 1000) / this.unitsPerEm);
      this._advCache.set(gid, w);
    }
    return w;
  }

  _glyph(gid) {
    const b = this.buf, loca = this.t('loca'), glyf = this.t('glyf');
    const at = (i) => (this.longLoca ? b.readUInt32BE(loca + i * 4) : b.readUInt16BE(loca + i * 2) * 2);
    const s = at(gid), e = at(gid + 1);
    return b.subarray(glyf + s, glyf + e);
  }

  /** Glyph ids referenced by composite glyphs, transitively. */
  _closure(gids) {
    const out = new Set(gids), queue = [...gids];
    while (queue.length) {
      const g = this._glyph(queue.pop());
      if (g.length < 10 || g.readInt16BE(0) >= 0) continue;
      let p = 10, flags;
      do {
        flags = g.readUInt16BE(p);
        const comp = g.readUInt16BE(p + 2);
        if (!out.has(comp)) { out.add(comp); queue.push(comp); }
        p += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0);
      } while (flags & 0x20);
    }
    return out;
  }

  /** Build a minimal sfnt containing only `gids` (ids preserved). */
  subset(gids) {
    const keep = this._closure(new Set([0, ...gids]));
    const n = Math.max(...keep) + 1;
    const glyphs = [], loca = Buffer.alloc((n + 1) * 4);
    let off = 0;
    for (let g = 0; g < n; g++) {
      loca.writeUInt32BE(off, g * 4);
      if (!keep.has(g)) continue;
      const d = this._glyph(g);
      const padded = Buffer.alloc((d.length + 3) & ~3);
      d.copy(padded);
      glyphs.push(padded);
      off += padded.length;
    }
    loca.writeUInt32BE(off, n * 4);

    const b = this.buf, hmtxOff = this.t('hmtx');
    const hmtx = Buffer.alloc(n * 4);
    for (let g = 0; g < n; g++) {
      const i = Math.min(g, this.numHMetrics - 1);
      hmtx.writeUInt16BE(b.readUInt16BE(hmtxOff + i * 4), g * 4);
      const lsb = g < this.numHMetrics ? b.readInt16BE(hmtxOff + g * 4 + 2) : b.readInt16BE(hmtxOff + this.numHMetrics * 4 + (g - this.numHMetrics) * 2);
      hmtx.writeInt16BE(lsb, g * 4 + 2);
    }
    const copy = (tag) => Buffer.from(b.subarray(this.tables[tag].offset, this.tables[tag].offset + this.tables[tag].length));
    const head = copy('head');
    head.writeUInt32BE(0, 8);
    head.writeInt16BE(1, 50);
    const hhea = copy('hhea');
    hhea.writeUInt16BE(n, 34);
    const maxp = copy('maxp');
    maxp.writeUInt16BE(n, 4);

    const tables = { head, hhea, maxp, hmtx, loca, glyf: Buffer.concat(glyphs) };
    for (const tag of ['cvt ', 'fpgm', 'prep']) if (this.tables[tag]) tables[tag] = copy(tag);
    return buildSfnt(tables);
  }
}

function checksum(buf) {
  const p = Buffer.alloc((buf.length + 3) & ~3);
  buf.copy(p);
  let s = 0;
  for (let i = 0; i < p.length; i += 4) s = (s + p.readUInt32BE(i)) >>> 0;
  return s;
}

function buildSfnt(tables) {
  const tags = Object.keys(tables).sort();
  const num = tags.length;
  const es = Math.floor(Math.log2(num));
  const header = Buffer.alloc(12 + num * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(num, 4);
  header.writeUInt16BE(16 * 2 ** es, 6);
  header.writeUInt16BE(es, 8);
  header.writeUInt16BE(num * 16 - 16 * 2 ** es, 10);
  let off = header.length;
  const bodies = [];
  tags.forEach((tag, i) => {
    const data = tables[tag];
    const padded = Buffer.alloc((data.length + 3) & ~3);
    data.copy(padded);
    const r = 12 + i * 16;
    header.write(tag, r, 4, 'latin1');
    header.writeUInt32BE(checksum(data), r + 4);
    header.writeUInt32BE(off, r + 8);
    header.writeUInt32BE(data.length, r + 12);
    bodies.push(padded);
    off += padded.length;
  });
  const font = Buffer.concat([header, ...bodies]);
  const headAt = header.readUInt32BE(12 + tags.indexOf('head') * 16 + 8);
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headAt + 8);
  return font;
}

let cache = null;
/**
 * The bundled font families, loaded once per process, in fallback order: each character
 * is drawn with the first family that has a glyph for it. Korean ships regular only
 * (bold is synthesised) to keep the plugin small.
 */
function fonts() {
  if (!cache) {
    const dir = path.join(__dirname, 'fonts');
    const load = (file) => new TTFont(fs.readFileSync(path.join(dir, file + '.ttf')), file);
    cache = [
      { id: 'sc', regular: load('NotoSansSC-Regular'), bold: load('NotoSansSC-Bold') },
      { id: 'kr', regular: load('NotoSansKR-Regular'), bold: null },
      { id: 'th', regular: load('NotoSansThai-Regular'), bold: load('NotoSansThai-Bold') },
    ];
  }
  return cache;
}

/** True when some bundled family can draw every non-space character of `str`. */
function covers(str) {
  const fams = fonts();
  for (const ch of String(str ?? '')) {
    if (/\s/.test(ch)) continue;
    const cp = ch.codePointAt(0);
    if (!fams.some((f) => f.regular.has(cp))) return false;
  }
  return true;
}

module.exports = { TTFont, fonts, covers };
