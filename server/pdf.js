'use strict';
// Minimal PDF writer: embedded Noto Sans SC (subset per document, Type0/Identity-H with
// a ToUnicode map so text stays searchable), vector shapes, RGB images, multi-page.
const zlib = require('zlib');
const { fonts } = require('./font');

const n = (v) => (Math.round(v * 100) / 100).toString();

function rgb(hex) {
  const h = String(hex).replace('#', '');
  const v = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  return [0, 2, 4].map((i) => n(parseInt(v.slice(i, i + 2), 16) / 255)).join(' ');
}

const pdfText = (s) => '(' + String(s).replace(/[^\x20-\x7e]/g, '').replace(/([()\\])/g, '\\$1') + ')';
const utf16hex = (cp) => (cp > 0xffff
  ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp]).map((u) => u.toString(16).padStart(4, '0')).join('');

// Break opportunities: whitespace, and around every CJK / fullwidth character.
const CJK = '⺀-鿿豈-﫿　-〿＀-￯가-힯';
const TOKENS = new RegExp(`[${CJK}]|[^\\s${CJK}]+|\\s+`, 'g');

const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
const K = 0.5523;

class PdfDoc {
  constructor(opts = {}) {
    [this.width, this.height] = SIZES[opts.size] || SIZES.a4;
    this.title = opts.title || 'Document';
    this.pages = [];
    this.ops = null;
    this.images = [];
    const f = fonts();
    this.fonts = [
      { key: 'F1', tag: 'TRKPDR', font: f.regular, used: new Map() },
      { key: 'F2', tag: 'TRKPDB', font: f.bold, used: new Map() },
    ];
  }

  addPage() {
    this.ops = ['1 j 1 J']; // round joins/caps: no miter spikes on sharp route turns
    this.pages.push(this.ops);
    return this.pages.length;
  }

  setPage(i) { this.ops = this.pages[i]; }

  // All drawing methods take TOP-LEFT origin coordinates.
  Y(y) { return this.height - y; }

  fill(hex) { this.ops.push(rgb(hex) + ' rg'); return this; }
  stroke(hex) { this.ops.push(rgb(hex) + ' RG'); return this; }
  lineWidth(w) { this.ops.push(n(w) + ' w'); return this; }
  dash(on, off) { this.ops.push(on ? `[${n(on)} ${n(off ?? on)}] 0 d` : '[] 0 d'); return this; }
  save() { this.ops.push('q'); return this; }
  restore() { this.ops.push('Q'); return this; }

  _paint(mode) { this.ops.push(mode === 'stroke' ? 'S' : mode === 'both' ? 'B' : mode === 'clip' ? 'W n' : 'f'); }

  rect(x, y, w, h, mode = 'fill') {
    this.ops.push(`${n(x)} ${n(this.Y(y + h))} ${n(w)} ${n(h)} re`);
    this._paint(mode);
    return this;
  }

  roundRect(x, y, w, h, r, mode = 'fill') {
    r = Math.min(r, w / 2, h / 2);
    const t = this.Y(y), b = this.Y(y + h), c = r * K;
    this.ops.push(
      `${n(x + r)} ${n(t)} m ${n(x + w - r)} ${n(t)} l`,
      `${n(x + w - r + c)} ${n(t)} ${n(x + w)} ${n(t - r + c)} ${n(x + w)} ${n(t - r)} c`,
      `${n(x + w)} ${n(b + r)} l ${n(x + w)} ${n(b + r - c)} ${n(x + w - r + c)} ${n(b)} ${n(x + w - r)} ${n(b)} c`,
      `${n(x + r)} ${n(b)} l ${n(x + r - c)} ${n(b)} ${n(x)} ${n(b + r - c)} ${n(x)} ${n(b + r)} c`,
      `${n(x)} ${n(t - r)} l ${n(x)} ${n(t - r + c)} ${n(x + r - c)} ${n(t)} ${n(x + r)} ${n(t)} c h`,
    );
    this._paint(mode);
    return this;
  }

  clip(x, y, w, h, r = 0) { return r ? this.roundRect(x, y, w, h, r, 'clip') : this.rect(x, y, w, h, 'clip'); }

  line(x1, y1, x2, y2) {
    this.ops.push(`${n(x1)} ${n(this.Y(y1))} m ${n(x2)} ${n(this.Y(y2))} l S`);
    return this;
  }

  polyline(points) {
    if (points.length < 2) return this;
    const [first, ...rest] = points;
    this.ops.push(`${n(first[0])} ${n(this.Y(first[1]))} m ` + rest.map((p) => `${n(p[0])} ${n(this.Y(p[1]))} l`).join(' ') + ' S');
    return this;
  }

  circle(cx, cy, r, mode = 'fill') {
    const y = this.Y(cy), c = r * K;
    this.ops.push(
      `${n(cx + r)} ${n(y)} m`,
      `${n(cx + r)} ${n(y + c)} ${n(cx + c)} ${n(y + r)} ${n(cx)} ${n(y + r)} c`,
      `${n(cx - c)} ${n(y + r)} ${n(cx - r)} ${n(y + c)} ${n(cx - r)} ${n(y)} c`,
      `${n(cx - r)} ${n(y - c)} ${n(cx - c)} ${n(y - r)} ${n(cx)} ${n(y - r)} c`,
      `${n(cx + c)} ${n(y - r)} ${n(cx + r)} ${n(y - c)} ${n(cx + r)} ${n(y)} c h`,
    );
    this._paint(mode);
    return this;
  }

  /** Register an RGB raster; returns ops that paint it into the box (top-left origin). */
  imageOps(raster, x, y, w, h) {
    const name = `Im${this.images.length + 1}`;
    this.images.push({ name, raster });
    return ['q', `${n(w)} 0 0 ${n(h)} ${n(x)} ${n(this.Y(y + h))} cm`, `/${name} Do`, 'Q'];
  }

  _font(bold) { return this.fonts[bold ? 1 : 0]; }

  /** True when the bundled font has a glyph for every character of `str`. */
  covers(str) {
    const f = this.fonts[0].font;
    for (const ch of String(str ?? '')) if (!/\s/.test(ch) && !f.has(ch.codePointAt(0))) return false;
    return true;
  }

  measure(str, size = 10, bold = false) {
    const { font } = this._font(bold);
    let w = 0;
    for (const ch of String(str ?? '')) w += font.advance(font.gid(ch.codePointAt(0)));
    return (w * size) / 1000;
  }

  /** Draw text with its BASELINE at y. align: left | center | right (x is the anchor). */
  text(str, x, y, { size = 10, bold = false, color = '#111827', align = 'left' } = {}) {
    const s = String(str ?? '').replace(/[\r\n\t]+/g, ' ');
    if (!s) return this;
    const f = this._font(bold);
    let hex = '';
    for (const ch of s) {
      const cp = ch.codePointAt(0), gid = f.font.gid(cp);
      if (gid && !f.used.has(gid)) f.used.set(gid, cp);
      hex += gid.toString(16).padStart(4, '0');
    }
    let tx = x;
    if (align !== 'left') {
      const w = this.measure(s, size, bold);
      tx = align === 'center' ? x - w / 2 : x - w;
    }
    this.ops.push(`BT /${f.key} ${n(size)} Tf ${rgb(color)} rg ${n(tx)} ${n(this.Y(y))} Td <${hex}> Tj ET`);
    return this;
  }

  /** Shorten `str` with an ellipsis so it fits in maxW. */
  fit(str, maxW, size = 10, bold = false) {
    const s = String(str ?? '');
    if (this.measure(s, size, bold) <= maxW) return s;
    const chars = [...s];
    while (chars.length > 1 && this.measure(chars.join('') + '…', size, bold) > maxW) chars.pop();
    return chars.join('').trimEnd() + '…';
  }

  /** Word-wrap into lines no wider than maxW (CJK breaks between characters). */
  wrap(str, maxW, size = 10, bold = false) {
    const lines = [];
    for (const para of String(str ?? '').split(/\r?\n/)) {
      let line = '', space = false;
      for (const tok of para.match(TOKENS) || []) {
        if (/^\s+$/.test(tok)) { space = true; continue; }
        const cand = line + (space && line ? ' ' : '') + tok;
        space = false;
        if (this.measure(cand, size, bold) <= maxW) { line = cand; continue; }
        if (line) lines.push(line);
        line = '';
        if (this.measure(tok, size, bold) <= maxW) { line = tok; continue; }
        for (const ch of tok) { // an over-long token breaks anywhere
          if (line && this.measure(line + ch, size, bold) > maxW) { lines.push(line); line = ''; }
          line += ch;
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  }

  /** Serialize to a Buffer. */
  toBuffer() {
    const objs = [];
    const add = (o) => { objs.push(o); return objs.length; };
    const stream = (dict, data) => ({ dict, data: zlib.deflateSync(data) });
    const catalog = add(null), pages = add(null);

    // Fonts: subset each face to the glyphs this document drew.
    const fontRefs = {};
    for (const f of this.fonts) {
      if (!f.used.size) continue;
      const gids = [...f.used.keys()].sort((a, b) => a - b);
      const sub = f.font.subset(gids);
      const base = `${f.tag}+${f.font.name}`;
      const scale = 1000 / f.font.unitsPerEm;
      const file = add(stream(`/Length1 ${sub.length}`, sub));
      const desc = add(`<< /Type /FontDescriptor /FontName /${base} /Flags 4 /FontBBox [${f.font.bbox.map((v) => Math.round(v * scale)).join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(f.font.ascent * scale)} /Descent ${Math.round(f.font.descent * scale)} /CapHeight ${Math.round(f.font.ascent * scale * 0.73)} /StemV ${f.key === 'F2' ? 140 : 80} /FontFile2 ${file} 0 R >>`);
      const widths = gids.map((g) => `${g} [${f.font.advance(g)}]`).join(' ');
      const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${base} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /DW 1000 /W [${widths}] /CIDToGIDMap /Identity >>`);
      const entries = gids.map((g) => `<${g.toString(16).padStart(4, '0')}> <${utf16hex(f.used.get(g))}>`);
      let bf = '';
      for (let i = 0; i < entries.length; i += 100) {
        const chunk = entries.slice(i, i + 100);
        bf += `${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar\n`;
      }
      const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${bf}endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
      const toUni = add(stream('', Buffer.from(cmap, 'latin1')));
      fontRefs[f.key] = add(`<< /Type /Font /Subtype /Type0 /BaseFont /${base} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUni} 0 R >>`);
    }
    const imgRefs = {};
    for (const im of this.images) {
      imgRefs[im.name] = add(stream(`/Type /XObject /Subtype /Image /Width ${im.raster.w} /Height ${im.raster.h} /ColorSpace /DeviceRGB /BitsPerComponent 8`, im.raster.rgb));
    }
    const fontDict = Object.entries(fontRefs).map(([k, r]) => `/${k} ${r} 0 R`).join(' ');
    const xobjDict = Object.entries(imgRefs).map(([k, r]) => `/${k} ${r} 0 R`).join(' ');
    const resources = `<< /Font << ${fontDict} >>${xobjDict ? ` /XObject << ${xobjDict} >>` : ''} >>`;

    const kids = [];
    for (const ops of this.pages) {
      const c = add(stream('', Buffer.from(ops.join('\n'), 'latin1')));
      kids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${n(this.width)} ${n(this.height)}] /Resources ${resources} /Contents ${c} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
    objs[pages - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const d = new Date(), pad = (v) => String(v).padStart(2, '0');
    const date = `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
    // Title as UTF-16BE hex so non-Latin trip names survive in the document properties.
    const title = '<FEFF' + [...this.title].map((ch) => utf16hex(ch.codePointAt(0))).join('') + '>';
    const info = add(`<< /Title ${title} /Producer ${pdfText('Trek PDF')} /CreationDate (${date}) >>`);

    const parts = [];
    let len = 0;
    const push = (b) => { parts.push(b); len += b.length; };
    push(Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1'));
    const offsets = [];
    objs.forEach((o, i) => {
      offsets.push(len);
      if (typeof o === 'string') { push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')); return; }
      push(Buffer.from(`${i + 1} 0 obj\n<< ${o.dict ? o.dict + ' ' : ''}/Filter /FlateDecode /Length ${o.data.length} >>\nstream\n`, 'latin1'));
      push(o.data);
      push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    });
    const xref = len;
    let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) tail += `${String(o).padStart(10, '0')} 00000 n \n`;
    tail += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    push(Buffer.from(tail, 'latin1'));
    return Buffer.concat(parts);
  }
}

module.exports = { PdfDoc };
