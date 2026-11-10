'use strict';
// node --test  — runs the routes against the SDK's grant-enforcing mock host.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createMockHost } = require('trek-plugin-sdk/testing');
const plugin = require('../server/index.js');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dev-fixtures.json'), 'utf8'));
const GRANTS = ['db:read:trips', 'db:read:costs', 'db:write:files'];
const route = (p) => plugin.routes.find((r) => r.path === p);
const call = async (ctx, p, body) => {
  const res = await route(p).handler({ method: 'POST', path: p, query: {}, body, headers: {}, user: { id: 1 } }, ctx);
  return { status: res.status, body: JSON.parse(res.body) };
};
// basemap:false keeps route tests offline; NET=1 adds a live OpenStreetMap render below.
const host = (over = {}) => createMockHost({ ...structuredClone(fixtures), grants: GRANTS, config: { basemap: false }, ...over });

test('summary returns stats, map geometry and cost totals', async () => {
  const { status, body } = await call(host().ctx, '/summary', { tripId: 1, locale: 'en' });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.title, 'Japan Summer 2026');
  assert.strictEqual(body.days, 5);
  assert.strictEqual(body.stops, 13);
  assert.strictEqual(body.unscheduled, 2);
  assert.strictEqual(body.map.empty, false);
  assert.strictEqual(body.map.routes.length, 5);
  assert.strictEqual(body.costs[0].currency, 'JPY');
  assert.strictEqual(body.costs[0].total, 470100);
  assert.strictEqual(body.costs[1].currency, 'EUR');
});

test('report renders a well-formed PDF and saves it to trip files', async () => {
  const h = host({ grants: [...GRANTS, 'db:read:files'] }); // read grant only so the test can list
  const { status, body } = await call(h.ctx, '/report', { tripId: 1, locale: 'en', paper: 'a4' });
  assert.strictEqual(status, 200, JSON.stringify(body));
  const list = await h.ctx.files.list(1);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].mimetype, 'application/pdf');
  assert.match(list[0].name, /^Japan Summer 2026 - Trip report \d{4}-\d{2}-\d{2}\.pdf$/);

  // Re-render to inspect the bytes (the mock doesn't keep content).
  const { loadTrip, renderPdf } = require('../server/report');
  const { renderBasemap } = require('../server/tiles');
  const basemap = process.env.NET ? (m, scale) => renderBasemap(m.view, m.w, m.h, scale) : null;
  const buf = (await renderPdf(await loadTrip(h.ctx, 1, { locale: 'en', timeZone: 'Asia/Tokyo' }), { basemap })).toBuffer();
  const pdf = buf.toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.5'));
  // Every xref offset must point at its "N 0 obj" header.
  const xrefAt = Number(pdf.match(/startxref\n(\d+)/)[1]);
  const entries = pdf.slice(xrefAt).split('\n').filter((l) => / 00000 n $/.test(l));
  entries.forEach((l, i) => assert.ok(pdf.startsWith(`${i + 1} 0 obj`, Number(l.slice(0, 10))), `object ${i + 1} offset`));
  if (process.env.PDF_OUT) fs.writeFileSync(process.env.PDF_OUT, buf);
});

test('costs addon disabled degrades gracefully', async () => {
  const { status, body } = await call(host({ budgetAddonEnabled: false }).ctx, '/summary', { tripId: 1 });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.costsEnabled, false);
  assert.strictEqual(body.costs, null);
});

test('non-member is refused', async () => {
  const { status } = await call(host({ actingUserId: 99 }).ctx, '/summary', { tripId: 1 });
  assert.strictEqual(status, 403);
});

test('missing write grant surfaces as an error, not a crash', async () => {
  const h = createMockHost({ ...structuredClone(fixtures), grants: ['db:read:trips', 'db:read:costs'] });
  const { status, body } = await call(h.ctx, '/report', { tripId: 1 });
  assert.strictEqual(status, 500);
  assert.match(body.error, /db:write:files|PERMISSION/i);
});

test('empty trip renders the empty-map state', async () => {
  const h = createMockHost({ grants: GRANTS, actingUserId: 1, trips: { 2: { members: [1], data: { id: 2, title: 'Zürich → Łódź ☃' } } } });
  const { status, body } = await call(h.ctx, '/report', { tripId: 2 });
  assert.strictEqual(status, 200, JSON.stringify(body));
});

test('CJK, Cyrillic and accented text is embedded, not replaced by ?', async () => {
  const { PdfDoc } = require('../server/pdf');
  const doc = new PdfDoc();
  doc.addPage();
  const s = '東京タワー · 北京烤鸭 · Москва · Zürich';
  doc.text(s, 40, 40);
  for (const ch of s.replace(/[\s·]/g, '')) {
    const gid = doc.fonts[0].font.gid(ch.codePointAt(0));
    assert.ok(gid > 0, `no glyph for ${ch}`);
    assert.strictEqual(doc.fonts[0].used.get(gid), ch.codePointAt(0));
  }
  // CJK wraps between characters even without spaces.
  const lines = doc.wrap('富士山に登るなら早朝出発がおすすめです。山頂まで約六時間かかります。', 120, 10);
  assert.ok(lines.length > 1 && lines.every((l) => doc.measure(l, 10) <= 120));
  const pdf = doc.toBuffer().toString('latin1');
  assert.match(pdf, /\/ToUnicode \d+ 0 R/);
  assert.match(pdf, /\/FontFile2 \d+ 0 R/);
});

test('PNG codec round-trips', () => {
  const { encodePng, decodePng } = require('../server/png');
  const rgb = Buffer.alloc(7 * 5 * 3).map((_, i) => (i * 37) & 255);
  const back = decodePng(encodePng({ w: 7, h: 5, rgb }));
  assert.deepStrictEqual([back.w, back.h], [7, 5]);
  assert.ok(back.rgb.equals(rgb));
});
