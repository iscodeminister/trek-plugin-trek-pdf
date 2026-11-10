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
  const { renderBasemap } = require('../server/basemap');
  const lang = process.env.LANG_OUT || 'en';
  const basemap = process.env.NET ? (m, o) => renderBasemap(m, { ...o, lang, pdf: true }) : null;
  const buf = (await renderPdf(await loadTrip(h.ctx, 1, { lang, locale: require('../server/i18n').intlLocale(lang), timeZone: 'Asia/Tokyo' }), { basemap })).toBuffer();
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
  const s = '東京タワー · 北京烤鸭 · Москва · Zürich · 서울 · กรุงเทพฯ';
  doc.text(s, 40, 40);
  doc.text(s, 40, 60, { bold: true }); // Korean bold is synthesised from the regular face
  for (const bold of [false, true]) {
    for (const r of doc._runs(s, bold)) for (const [gid, cp] of r.glyphs) {
      if (/\s/.test(String.fromCodePoint(cp))) continue;
      assert.ok(gid > 0, `no glyph for ${String.fromCodePoint(cp)}`);
      assert.strictEqual(r.face.used.get(gid), cp);
    }
  }
  const faces = doc.faces.filter((f) => f.used.size).map((f) => f.font.name);
  assert.ok(faces.includes('NotoSansKR-Regular') && faces.includes('NotoSansThai-Regular') && faces.includes('NotoSansSC-Bold'), faces.join());
  // CJK wraps between characters even without spaces.
  const lines = doc.wrap('富士山に登るなら早朝出発がおすすめです。山頂まで約六時間かかります。', 120, 10);
  assert.ok(lines.length > 1 && lines.every((l) => doc.measure(l, 10) <= 120));
  const pdf = doc.toBuffer().toString('latin1');
  assert.match(pdf, /\/ToUnicode \d+ 0 R/);
  assert.match(pdf, /\/FontFile2 \d+ 0 R/);
});

test('language codes from the host normalise to TREK codes', () => {
  const { normalizeLang } = require('../server/i18n');
  assert.deepStrictEqual(['de', 'de-AT', 'zh-CN', 'zh-TW', 'zh-Hant', 'pt-BR', 'br', 'el', 'gr', 'xx', '', 'ko_KR'].map(normalizeLang),
    ['de', 'de', 'zh', 'zh-TW', 'zh-TW', 'br', 'br', 'gr', 'gr', 'en', 'en', 'ko']);
});

test('summary and report follow the UI language (PDF falls back to English for ar/he)', async () => {
  const sum = await call(host().ctx, '/summary', { tripId: 1, lang: 'de', locale: 'de-DE' });
  assert.strictEqual(sum.body.i18n.lang, 'de');
  assert.strictEqual(sum.body.i18n.strings.generate, 'PDF erstellen');
  assert.strictEqual(sum.body.map.legend[0].label.startsWith('Tag 1'), true);
  const ar = await call(host().ctx, '/summary', { tripId: 1, lang: 'ar' });
  assert.strictEqual(ar.body.i18n.dir, 'rtl');
  assert.strictEqual(ar.body.i18n.pdfInEnglish, true);

  const h = host({ grants: [...GRANTS, 'db:read:files'] });
  for (const [lang, word] of [['de', 'Reisebericht'], ['ja', '旅行レポート'], ['ar', 'Trip report'], ['ko', '여행 보고서']]) {
    const r = await call(h.ctx, '/report', { tripId: 1, lang });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.file.name.includes(word), `${lang}: ${r.body.file.name}`);
  }
});

test('basemap route returns null when the background is turned off', async () => {
  const { status, body } = await call(host().ctx, '/basemap', { tripId: 1, view: 0 });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.basemap, null);
});

test('basemap route validates an explicit view; unknown styles fall back', async () => {
  const on = createMockHost({ ...structuredClone(fixtures), grants: GRANTS, config: { basemap: true, map_style: 'bright' } });
  for (const view of [{ cx: 9, cy: 0, k: 1000 }, { cx: 0, cy: 0, k: 'x' }, { cx: 0, cy: NaN, k: 1000 }]) {
    const r = await call(on.ctx, '/basemap', { view });
    assert.strictEqual(r.status, 400, JSON.stringify(view));
  }
  const s = await call(on.ctx, '/summary', { tripId: 1 });
  assert.deepStrictEqual(s.body.styles, ['positron', 'bright', 'liberty', 'dark', 'fiord', 'osm']);
  assert.strictEqual(s.body.style, 'bright'); // admin default
  const noConfig = createMockHost({ ...structuredClone(fixtures), grants: GRANTS, config: { map_style: 'nope' } });
  assert.strictEqual((await call(noConfig.ctx, '/summary', { tripId: 1 })).body.style, 'bright'); // built-in default
  const m = s.body.map.markers.find((k) => k.n === 1);
  assert.ok(Number.isFinite(m.lat) && Number.isFinite(m.lng), 'markers carry lat/lng for client-side zoom');
  assert.ok(s.body.map.routes.every((r) => r.ll.length === r.points.length));
});

test('report uses the zoom saved in the tab; invalid views are ignored', async () => {
  const { buildMap, PREVIEW } = require('../server/report');
  const { loadTrip } = require('../server/report');
  const h = host({ grants: [...GRANTS, 'db:read:files'] });
  const data = await loadTrip(h.ctx, 1, {});
  const fit = buildMap(data, ...PREVIEW);
  const zoomed = [fit.view.cx + 0.01, fit.view.cy, fit.view.k * 4];
  // Same centre, and k rescaled so the preview's area fits the PDF map size.
  const m = buildMap(data, 300, 200, { view: { cx: zoomed[0], cy: zoomed[1], k: zoomed[2] * Math.min(300 / PREVIEW[0], 200 / PREVIEW[1]) } });
  assert.strictEqual(m.view.cx, zoomed[0]);
  assert.ok(Math.abs(m.view.k - zoomed[2] * (300 / 640)) < 1e-9);
  const ok = await call(h.ctx, '/report', { tripId: 1, views: { '-1': zoomed, 0: zoomed, bad: zoomed, 1: [1, 2], 2: [99, 0, 5] } });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
});

test('a long trip description is printed in full, not cut', async () => {
  const { loadTrip, renderPdf } = require('../server/report');
  const fx = structuredClone(fixtures);
  const sentence = 'Long intro sentence number NN about temples, food and trains across the country. ';
  fx.trips['1'].data.description = Array.from({ length: 60 }, (_, i) => sentence.replace('NN', i + 1)).join('');
  const h = createMockHost({ ...fx, grants: GRANTS });
  const doc = await renderPdf(await loadTrip(h.ctx, 1, {}), { sections: ['map'] });
  const drawn = [];
  const orig = doc.wrap.bind(doc);
  const lines = orig(fx.trips['1'].data.description, doc.width - 84, 9.5);
  assert.ok(lines.length > 4, 'test needs a multi-line intro');
  // Every wrapped line's glyph run must appear in some page's content.
  const all = doc.pages.flat().join('\n');
  for (const l of [lines[0], lines[Math.floor(lines.length / 2)], lines[lines.length - 1]]) {
    const hex = doc._runs(l, false).map((r) => r.glyphs.map(([g]) => g.toString(16).padStart(4, '0')).join('')).join('');
    assert.ok(all.includes(hex), `missing line: ${l}`);
    drawn.push(l);
  }
  assert.strictEqual(drawn.length, 3);
});
