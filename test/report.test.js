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
  assert.strictEqual(body.stops, 15);
  assert.strictEqual(body.tours, 2);
  assert.strictEqual(body.map.tracks.length, 2);
  assert.strictEqual(body.unscheduled, 2);
  assert.strictEqual(body.map.empty, false);
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
  assert.match(list[0].name, /^Japan Summer 2026 - Trip report \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.pdf$/);

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
  assert.deepStrictEqual(s.body.styles.map((x) => x.id), ['positron', 'bright', 'liberty', 'dark', 'fiord', 'osm']);
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
  const ok = await call(h.ctx, '/report', { tripId: 1, views: { all: zoomed, d1: zoomed, bad: zoomed, d2: [1, 2], d3: [99, 0, 5], '-1': zoomed } });
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

test('timeline section draws the timed stops; it can be picked alone', async () => {
  const { loadTrip, renderPdf, SECTIONS } = require('../server/report');
  assert.ok(SECTIONS.includes('timeline'));
  const h = createMockHost({ ...fixtures, grants: GRANTS });
  const data = await loadTrip(h.ctx, 1, {});
  const doc = await renderPdf(data, { sections: ['timeline'] });
  const all = doc.pages.flat().join('\n');
  const hex = (s, bold) => doc._runs(s, bold).map((r) => r.glyphs.map(([g]) => g.toString(16).padStart(4, '0')).join('')).join('');
  assert.ok(all.includes(hex('Timeline', true)), 'heading drawn');
  assert.ok(all.includes(hex('09:00', false)), 'hour axis drawn');
  const res = await call(h.ctx, '/report', { tripId: 1, sections: ['timeline'] });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
});

test('file name and cover carry the creation time in the user time zone', async () => {
  const { loadTrip, fileName } = require('../server/report');
  const h = createMockHost({ ...fixtures, grants: GRANTS });
  const data = await loadTrip(h.ctx, 1, { timeZone: 'Asia/Tokyo' });
  data.generatedAt = new Date('2026-11-12T05:07:00Z');
  assert.match(fileName(data), / 2026-11-12 14-07\.pdf$/);
});

test('tours: track metrics match TREK, tours section renders, times come from the assignment', async () => {
  const { loadTrip, renderPdf, buildMap } = require('../server/report');
  const h = createMockHost({ ...fixtures, grants: GRANTS });
  const data = await loadTrip(h.ctx, 1, {});
  assert.strictEqual(data.tours.length, 2);
  const [hike, walk] = data.tours;
  assert.deepStrictEqual(hike.days, [2]);
  assert.strictEqual(hike.time, '07:45'); // assignment_time, not the place's own time
  assert.strictEqual(hike.duration, 150);
  assert.ok(hike.track.km > 2 && hike.track.km < 6, String(hike.track.km));
  assert.ok(hike.track.gain > 150 && hike.track.gain < 260, String(hike.track.gain)); // jitter filtered
  assert.ok(Math.abs(hike.track.gain - hike.track.loss) < 6, 'a loop climbs what it descends');
  assert.strictEqual(hike.track.loop, true);
  assert.strictEqual(walk.track.gain, null); // no heights in the track
  assert.strictEqual(walk.track.profile, null);
  // Maps fit and draw the tracks.
  const m = buildMap(data, 640, 380);
  assert.strictEqual(m.tracks.length, 2);
  assert.ok(m.tracks[0].points.every(([x, y]) => x >= 0 && x <= 640 && y >= 0 && y <= 380));
  const doc = await renderPdf(data, { sections: ['tours'] });
  const all = doc.pages.flat().join('\n');
  const hex = (s, bold) => doc._runs(s, bold).map((r) => r.glyphs.map(([g]) => g.toString(16).padStart(4, '0')).join('')).join('');
  assert.ok(all.includes(hex('Tours', true)), 'heading drawn');
  assert.ok(all.includes(hex('ASCENT', true)), 'figures drawn');
  // Broken geometry is ignored, not fatal.
  const fx = structuredClone(fixtures);
  fx.trips['1'].days[2].assignments[1].tour_route_geometry = '{oops';
  fx.trips['1'].places.find((p) => p.id === 16).route_geometry = '[[1,2]]';
  const d2 = await loadTrip(createMockHost({ ...fx, grants: GRANTS }).ctx, 1, {});
  assert.strictEqual(d2.tours.length, 1);
});

test('tour detail: the detailed layout adds a gridded profile, average speed and positions', async () => {
  const { loadTrip, renderPdf } = require('../server/report');
  const h = createMockHost({ ...fixtures, grants: [...GRANTS, 'db:read:files'] });
  const data = await loadTrip(h.ctx, 1, {});
  const hex = (doc, s, bold) => doc._runs(s, bold).map((r) => r.glyphs.map(([g]) => g.toString(16).padStart(4, '0')).join('')).join('');
  const compact = await renderPdf(data, { sections: ['tours'] });
  const full = await renderPdf(data, { sections: ['tours'], tourDetail: 'full' });
  const text = (doc) => doc.pages.flat().join('\n');
  assert.ok(!text(compact).includes(hex(compact, 'AVERAGE SPEED', true)));
  assert.ok(text(full).includes(hex(full, 'AVERAGE SPEED', true)));
  assert.ok(text(full).length > text(compact).length);
  // The route accepts the option; anything else means compact.
  for (const tourDetail of ['full', 'compact', 'nonsense']) {
    const res = await call(h.ctx, '/report', { tripId: 1, sections: ['tours'], tourDetail });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  }
});

test('tours name the positions along their route, and the summary carries the tab preview', async () => {
  const { loadTrip } = require('../server/report');
  const h = createMockHost({ ...fixtures, grants: GRANTS });
  const data = await loadTrip(h.ctx, 1, {});
  assert.deepStrictEqual(data.tours[0].positions.map((p) => p.name), ['Fushimi Inari Taisha']);
  assert.deepStrictEqual(data.tours[1].positions.map((p) => p.name), ['Arashiyama Bamboo Grove']);
  const { body } = await call(h.ctx, '/summary', { tripId: 1, locale: 'en' });
  assert.strictEqual(body.tourList.length, 2);
  const [hike, walk] = body.tourList;
  assert.strictEqual(hike.day, 2);
  assert.ok(/Day 3/.test(hike.when) && /07:45/.test(hike.when), hike.when);
  assert.deepStrictEqual(hike.figs.map((f) => f[0]), ['Distance', 'Ascent', 'Descent', 'Duration', 'Average speed', 'Highest point', 'Lowest point']);
  assert.ok(hike.line.length <= 120 && hike.profile.length <= 90);
  assert.deepStrictEqual(hike.positions, ['Fushimi Inari Taisha']);
  assert.strictEqual(walk.profile, null);
});

test('a tour map follows the zoom framed for it in the tab; a stale one is ignored', async () => {
  const { loadTrip, tourMap, renderPdf } = require('../server/report');
  const h = createMockHost({ ...fixtures, grants: [...GRANTS, 'db:read:files'] });
  const { body } = await call(h.ctx, '/summary', { tripId: 1, locale: 'en' });
  assert.strictEqual(body.tourMaps.length, 2);
  assert.ok(body.tourMaps[0].tracks.length === 1 && body.tourMaps[0].markers.every((m) => m.title));
  const data = await loadTrip(h.ctx, 1, {});
  const fit = tourMap(data, data.tours[0], 640, 380).view;
  const zoomed = { cx: fit.cx, cy: fit.cy, k: fit.k * 3 };
  assert.strictEqual(tourMap(data, data.tours[0], 640, 380, { view: zoomed }).view.k, zoomed.k);
  // A view saved for some other place (the tours changed since) falls back to the fitted one.
  assert.strictEqual(tourMap(data, data.tours[0], 640, 380, { view: { cx: 0, cy: 0, k: zoomed.k } }).view.k, fit.k);
  const plain = await renderPdf(data, { sections: ['tours'] });
  const framed = await renderPdf(data, { sections: ['tours'], views: { [`t${data.tours[0].key}`]: [zoomed.cx, zoomed.cy, zoomed.k] } });
  assert.notStrictEqual(framed.pages.flat().join('\n'), plain.pages.flat().join('\n'));
  const res = await call(h.ctx, '/report', { tripId: 1, sections: ['tours'], views: { [`t${data.tours[0].key}`]: [zoomed.cx, zoomed.cy, zoomed.k], t9999: [0, 0, 100], 't!': [0, 0, 100] } });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
});

// ---- saved views and choices (db:own). The mock host's db is canned, so back it with a real
// in-memory SQLite here, exposing the same query/exec/migrate/tx surface the host gives.
function sqliteDb() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const applied = new Set();
  return {
    async query(sql, ...args) { return db.prepare(sql).all(...args); },
    async exec(sql, ...args) { return { changes: Number(db.prepare(sql).run(...args).changes) }; },
    async migrate(id, sql) { if (applied.has(id)) return { applied: false }; db.exec(sql); applied.add(id); return { applied: true }; },
    async tx(ops) {
      db.exec('BEGIN');
      try {
        const results = ops.map((o) => (/^\s*select/i.test(o.sql) ? { rows: db.prepare(o.sql).all(...(o.args || [])) } : { changes: Number(db.prepare(o.sql).run(...(o.args || [])).changes) }));
        db.exec('COMMIT');
        return { results };
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
const withDb = (h, db = sqliteDb()) => Object.assign(Object.create(h.ctx), { db });

test('dragged map views and tab choices are saved per user and come back with the summary', async () => {
  const h = host({ grants: [...GRANTS, 'db:own'] });
  const ctx = withDb(h);
  const first = await call(ctx, '/summary', { tripId: 1, locale: 'en' });
  assert.deepStrictEqual(first.body.saved, { views: {}, prefs: {} });
  assert.strictEqual(first.body.map.key, 'all');
  assert.deepStrictEqual(first.body.dayMaps.map((m) => m.key), ['d1', 'd2', 'd3', 'd4', 'd5']);
  assert.ok(first.body.styles.every((s) => s.id && s.name && s.swatch && s.swatch.bg));

  const v = [2.4, 0.66, 9000];
  const saved = await call(ctx, '/prefs', { tripId: 1, views: { all: v, d2: v, bogus: v, d3: [1, 2] }, prefs: { style: 'dark', paper: 'letter', tourDetail: 'full', sections: ['map', 'costs', 'nope'], evil: 1 } });
  assert.deepStrictEqual(saved.body, { stored: true, views: 2 });
  const again = await call(ctx, '/summary', { tripId: 1, locale: 'en' });
  assert.deepStrictEqual(again.body.saved.views, { all: v, d2: v });
  assert.deepStrictEqual(again.body.saved.prefs, { style: 'dark', paper: 'letter', tourDetail: 'full', sections: ['map', 'costs'] });
  assert.strictEqual(again.body.style, 'dark'); // the user's pick wins over the admin default

  // Reset (null) forgets a view; other users and other trips see nothing of it.
  await call(ctx, '/prefs', { tripId: 1, views: { d2: null } });
  assert.deepStrictEqual((await call(ctx, '/summary', { tripId: 1, locale: 'en' })).body.saved.views, { all: v });
  const other = Object.assign(Object.create(ctx), {});
  const res = await route('/summary').handler({ method: 'POST', path: '/summary', query: {}, body: { tripId: 1, locale: 'en' }, headers: {}, user: { id: 2 } }, other);
  assert.deepStrictEqual(JSON.parse(res.body).saved.views, {});

  // The PDF uses a saved view even when the tab sends none.
  const plugin2 = require('../server/index.js');
  assert.ok(plugin2.deleteUserData && plugin2.exportUserData);
  const rep = await call(Object.assign(Object.create(ctx), { files: withDb(host({ grants: [...GRANTS, 'db:own'] })).files }), '/report', { tripId: 1, sections: ['map'] });
  assert.strictEqual(rep.status, 200, JSON.stringify(rep.body));

  // GDPR: export returns the rows, delete removes them.
  const rows = await plugin.exportUserData({ userId: 1 }, ctx);
  assert.ok(rows.length >= 5 && rows.every((r) => 'key' in r && 'value' in r));
  await plugin.deleteUserData({ userId: 1 }, ctx);
  assert.deepStrictEqual(await plugin.exportUserData({ userId: 1 }, ctx), []);
});

test('saving is refused for a trip the user cannot see, and degrades without storage', async () => {
  const ctx = withDb(host({ grants: [...GRANTS, 'db:own'] }));
  const res = await call(ctx, '/prefs', { tripId: 999, views: { all: [1, 0.5, 900] } });
  assert.ok(res.status === 403 || res.status === 404 || res.status === 500, String(res.status));
  // No db:own grant: the summary still works and says storage is unavailable.
  const noDb = await call(host().ctx, '/summary', { tripId: 1, locale: 'en' });
  assert.strictEqual(noDb.status, 200);
  assert.strictEqual(noDb.body.saved, null);
  const s = await call(host().ctx, '/prefs', { tripId: 1, views: { all: [1, 0.5, 900] } });
  assert.deepStrictEqual(s.body, { stored: false, views: 1 });
});

test('a saved view keys on the day id, so reordering days never moves it to another day', async () => {
  const { loadTrip, renderPdf } = require('../server/report');
  const fx = structuredClone(fixtures);
  const data = await loadTrip(createMockHost({ ...fx, grants: GRANTS }).ctx, 1, {});
  const d2 = data.days[1];
  const v = { [`d${d2.id}`]: [2.4, 0.62, 30000] };
  const a = await renderPdf(data, { sections: ['itinerary', 'map'], views: v });
  // Same days, different order of ids → the view follows its day, not its position.
  fx.trips['1'].days.reverse();
  const shuffled = await loadTrip(createMockHost({ ...fx, grants: GRANTS }).ctx, 1, {});
  assert.strictEqual(shuffled.days.find((d) => d.id === d2.id).id, d2.id);
  const b = await renderPdf(shuffled, { sections: ['itinerary', 'map'], views: v });
  assert.strictEqual(a.pages.length, b.pages.length);
});

test('Markdown in notes prints as clean text: no **, pipes, separator rows or link URLs', async () => {
  const { blocks } = require('../server/markdown');
  const note = [
    '## 今日流程',
    '**2/21（日）** 早上直接去清水寺 ** 之後沿',
    '| 路段 | 怎麼走 |',
    '|---|---|',
    '| 怎麼搭 | 四條寺町 → 清水寺 |',
    '- 點開[看路線](https://maps.example.com/route?a=(1)) 共 8 個',
    '  1. 子項 *重點* `JR`',
    '- [ ] 帶傘',
    '---',
    'Plain line with 5_000 yen and a*b*c',
  ].join('\n');
  const b = blocks(note);
  assert.deepStrictEqual(b.map((x) => x.text), ['今日流程', '2/21（日） 早上直接去清水寺 之後沿', '路段 · 怎麼走', '怎麼搭 · 四條寺町 → 清水寺', '點開看路線 共 8 個', '子項 重點 JR', '帶傘', 'Plain line with 5_000 yen and a*b*c']);
  assert.deepStrictEqual(b.map((x) => x.bold), [true, false, true, false, false, false, false, false]);
  assert.deepStrictEqual(b.map((x) => [x.bullet, x.level]), [['', 0], ['', 0], ['', 0], ['', 0], ['•', 0], ['1.', 1], ['☐', 0], ['', 0]]);
  assert.deepStrictEqual(blocks('just\nplain text').map((x) => x.text), ['just', 'plain text']);

  // In the PDF: the markers never reach the page.
  const { loadTrip, renderPdf } = require('../server/report');
  const fx = structuredClone(fixtures);
  fx.trips['1'].days[0].notes_items = [{ text: note }];
  fx.trips['1'].days[0].assignments[0].notes = '**Book** [tickets](https://example.com) | early';
  const data = await loadTrip(createMockHost({ ...fx, grants: GRANTS }).ctx, 1, {});
  const doc = await renderPdf(data, { sections: ['itinerary'] });
  const all = doc.pages.flat().join('\n');
  const hex = (s, bold) => doc._runs(s, bold).map((r) => r.glyphs.map(([g]) => g.toString(16).padStart(4, '0')).join('')).join('');
  assert.ok(all.includes(hex('今日流程', true)), 'heading printed bold');
  assert.ok(all.includes(hex('怎麼搭 · 四條寺町 → 清水寺', false)), 'table row printed as a line');
  assert.ok(!all.includes(hex('|---|---|', false)), 'separator row dropped');
  assert.ok(!all.includes(hex('https://example.com', false)), 'link URL dropped');
  assert.ok(all.includes(hex('Book tickets | early', false)), 'inline markers stripped in place notes');
});
