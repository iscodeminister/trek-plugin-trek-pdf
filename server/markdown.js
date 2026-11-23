'use strict';
// Notes in TREK are often Markdown (pasted from an AI planner, a blog, a spreadsheet).
// The PDF has no Markdown renderer, so turn it into plain, readable lines: headings and
// table headers bold, list items with their bullet or number, table rows as "a · b · c",
// links as their text, and every leftover marker (**, `, ~~, |---|) gone.

/** Inline Markdown → plain text. */
function inline(s) {
  return String(s)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, '')                     // other HTML tags
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')              // images → alt text
    .replace(/\[([^\]]+)\]\((?:[^()\s]+|\([^)]*\))*(?:\s+"[^"]*")?\)/g, '$1') // [text](url) → text
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')              // [text][ref]
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')       // <https://…>
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')       // **bold** / __bold__
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1$2') // *italic*
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')     // _italic_
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/\*\*|__/g, '')                               // an unclosed ** left over
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, '$1')        // \* → *
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => inline(c)).filter(Boolean);

/**
 * Markdown → blocks: { text, bold, bullet, level } where bullet is '•', '1.' or ''.
 * Plain text without any Markdown comes back as one block per line, unchanged.
 */
function blocks(src) {
  const out = [];
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) { if (raw.trim()) out.push({ text: raw.trim(), bold: false, bullet: '', level: 0 }); continue; }
    const line = raw.replace(/^\s*>\s?/, '');               // blockquote
    if (!line.trim()) continue;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;  // horizontal rule
    // Table: a row of cells; the separator row goes, the row before it is the header.
    if (/^\s*\|/.test(line) || (/\|/.test(line) && TABLE_SEP.test(lines[i + 1] || ''))) {
      if (TABLE_SEP.test(line)) continue;
      const c = cells(line);
      if (c.length) out.push({ text: c.join(' · '), bold: TABLE_SEP.test(lines[i + 1] || ''), bullet: '', level: 0 });
      continue;
    }
    let m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) { const text = inline(m[2]); if (text) out.push({ text, bold: true, bullet: '', level: 0 }); continue; }
    m = /^(\s*)([-*+]|\d{1,3}[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    if (m) {
      const level = Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2));
      const bullet = m[3] !== undefined ? (m[3] === ' ' ? '☐' : '☑') : /\d/.test(m[2]) ? m[2].replace(')', '.') : '•';
      const text = inline(m[4]);
      if (text) out.push({ text, bold: false, bullet, level });
      continue;
    }
    // Setext heading underline ("Title\n=====") is a heading for the line before.
    if (/^\s*(=+|-+)\s*$/.test(line) && out.length) { out[out.length - 1].bold = true; continue; }
    const text = inline(line);
    if (text) out.push({ text, bold: false, bullet: '', level: 0 });
  }
  return out;
}

module.exports = { blocks, inline };
