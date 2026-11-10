'use strict';
// Minimal Mapbox Vector Tile (protobuf) decoder. Only the layers asked for are decoded,
// which keeps memory flat inside the plugin's 192 MB heap.

class Pbf {
  constructor(buf, pos = 0, end = buf.length) { this.buf = buf; this.pos = pos; this.end = end; }
  varint() {
    let v = 0, mul = 1, b;
    do { b = this.buf[this.pos++]; v += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
    return v;
  }
  svarint() { const v = this.varint(); return v % 2 ? (v + 1) / -2 : v / 2; }
  bytes() { const len = this.varint(), s = this.pos; this.pos += len; return [s, this.pos]; }
  string() { const [s, e] = this.bytes(); return this.buf.toString('utf8', s, e); }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new Error('pbf: unsupported wire type ' + wire);
  }
  /** Iterate fields: cb(tag, wire) must consume the field or return false to skip it. */
  fields(cb) {
    while (this.pos < this.end) {
      const key = this.varint(), tag = key >> 3, wire = key & 7, at = this.pos;
      if (cb(tag, wire) === false && this.pos === at) this.skip(wire);
    }
  }
}

function readValue(p) {
  let v = null;
  p.fields((tag) => {
    if (tag === 1) v = p.string();
    else if (tag === 2) { v = p.buf.readFloatLE(p.pos); p.pos += 4; }
    else if (tag === 3) { v = p.buf.readDoubleLE(p.pos); p.pos += 8; }
    else if (tag === 4 || tag === 5) v = p.varint();
    else if (tag === 6) v = p.svarint();
    else if (tag === 7) v = p.varint() === 1;
    else return false;
    return true;
  });
  return v;
}

/** Geometry → array of rings/lines/points in tile units (0..extent). */
function geometry(buf, s, e) {
  const p = new Pbf(buf, s, e);
  const parts = [];
  let x = 0, y = 0, cur = null, cmd = 0, count = 0;
  while (p.pos < p.end) {
    if (!count) { const v = p.varint(); cmd = v & 7; count = v >> 3; }
    count--;
    if (cmd === 1 || cmd === 2) {
      x += p.svarint(); y += p.svarint();
      if (cmd === 1) { cur = []; parts.push(cur); }
      cur.push([x, y]);
    } else if (cmd === 7 && cur && cur.length) cur.push([cur[0][0], cur[0][1]]);
  }
  return parts;
}

/**
 * Decode the named layers of a tile.
 * @returns { [layerName]: { extent, features: [{ type, props, geom }] } }
 */
function decodeTile(buf, wanted) {
  const out = {};
  const tile = new Pbf(buf);
  tile.fields((tag) => {
    if (tag !== 3) return false;
    const [s, e] = tile.bytes();
    const L = new Pbf(buf, s, e);
    let name = null, extent = 4096;
    const keys = [], values = [], feats = [];
    L.fields((t) => {
      if (t === 1) name = L.string();
      else if (t === 3) keys.push(L.string());
      else if (t === 4) { const [vs, ve] = L.bytes(); values.push(readValue(new Pbf(buf, vs, ve))); }
      else if (t === 5) extent = L.varint();
      else if (t === 2) feats.push(L.bytes());
      else return false;
      return true;
    });
    if (!name || !wanted.has(name)) return true;
    const features = feats.map(([fs, fe]) => {
      const F = new Pbf(buf, fs, fe);
      let type = 0, tags = null, geom = null;
      F.fields((t) => {
        if (t === 2) { const [ts, te] = F.bytes(); const T = new Pbf(buf, ts, te); tags = []; while (T.pos < T.end) tags.push(T.varint()); }
        else if (t === 3) type = F.varint();
        else if (t === 4) geom = F.bytes();
        else return false;
        return true;
      });
      const props = {};
      if (tags) for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      return { type, props, geom: geom ? geometry(buf, geom[0], geom[1]) : [] };
    });
    out[name] = { extent, features };
    return true;
  });
  return out;
}

module.exports = { decodeTile };
