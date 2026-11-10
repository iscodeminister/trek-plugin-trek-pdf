'use strict';
const { PdfDoc } = require('./pdf');
const { covers: fontCovers } = require('./font');
const { ATTRIBUTION } = require('./basemap');
const { translator } = require('./i18n');

const DAY_COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5'];
const INK = '#111827', MUTED = '#6b7280', FAINT = '#9ca3af', LINE = '#e5e7eb', SOFT = '#f3f4f6', BRAND = '#0f172a', ACCENT = '#2563eb';

// ---------------------------------------------------------------- helpers

/** Run an optional ctx call; resolves `fallback` when it throws (missing addon, older host). */
async function attempt(fn, fallback) {
  try { return await fn(); } catch { return fallback; }
}

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const str = (...vals) => { for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim(); return ''; };

function parseDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(d)) return null;
  const t = new Date(d.slice(0, 10) + 'T00:00:00Z');
  return Number.isNaN(t.getTime()) ? null : t;
}

function fmtDate(d, locale, opts) {
  const t = d instanceof Date ? d : parseDate(d);
  if (!t) return '';
  try { return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...opts }).format(t); } catch { return t.toISOString().slice(0, 10); }
}

// The bundled fonts can't draw every currency symbol (₹, ₪…) → fall back to the code.
const covers = fontCovers;

function fmtMoney(amount, currency, locale) {
  const cur = String(currency || '').toUpperCase();
  try {
    const s = new Intl.NumberFormat(locale, { style: 'currency', currency: cur }).format(amount);
    if (covers(s)) return s;
    return new Intl.NumberFormat(locale, { style: 'currency', currency: cur, currencyDisplay: 'code' }).format(amount);
  } catch {
    const v = new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
    return cur ? `${cur} ${v}` : v;
  }
}

function fmtTime(t) {
  if (typeof t !== 'string' || !t) return '';
  const m = t.match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : t.slice(0, 5);
}

function validCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 85 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

// ---------------------------------------------------------------- data

/** Load and normalize everything the report needs. Must run inside a route handler. */
/**
 * @param opts.lang   TREK language code for all generated wording (see i18n.js)
 * @param opts.locale BCP-47 locale for dates and numbers
 */
async function loadTrip(ctx, tripId, { lang = 'en', locale = 'en-US', currency, timeZone } = {}) {
  const t = translator(lang);
  const trip = await ctx.trips.getById(tripId);
  if (!trip) {
    const e = new Error('Trip not found');
    e.status = 404;
    throw e;
  }
  const [places, rawDays, rawAccs, rawCosts] = await Promise.all([
    attempt(() => ctx.trips.getPlaces(tripId), []),
    attempt(() => ctx.trips.getDays(tripId), []),
    attempt(() => ctx.trips.getAccommodations(tripId), []),
    attempt(() => ctx.costs.getByTrip(tripId), null),
  ]);
  const placeById = new Map((places || []).map((p) => [String(p.id), p]));
  const used = new Set();

  const toStop = (a) => {
    const p = (a.place && typeof a.place === 'object' ? a.place : null) || placeById.get(String(a.place_id)) || {};
    if (p.id !== undefined) used.add(String(p.id));
    const cat = p.category && typeof p.category === 'object' ? p.category : null;
    return {
      name: str(p.name, a.name) || t('untitledPlace'),
      lat: num(p.lat ?? p.latitude),
      lng: num(p.lng ?? p.lon ?? p.longitude),
      time: fmtTime(str(a.place_time, p.place_time, a.start_time, a.time)),
      endTime: fmtTime(str(a.end_time, p.end_time)),
      category: str(cat && cat.name, p.category_name, typeof p.category === 'string' ? p.category : ''),
      address: str(p.address),
      notes: str(a.notes, p.notes, p.description),
    };
  };

  const days = (Array.isArray(rawDays) ? rawDays : [])
    .slice()
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || num(a.day_number) - num(b.day_number) || num(a.id) - num(b.id))
    .map((d, i) => {
      const assignments = (Array.isArray(d.assignments) ? d.assignments : [])
        .slice()
        .sort((a, b) => (num(a.order_index ?? a.position) || 0) - (num(b.order_index ?? b.position) || 0));
      const notes = (Array.isArray(d.notes_items) ? d.notes_items : [])
        .map((x) => str(x && x.text, x && x.content, x && x.title, typeof x === 'string' ? x : ''))
        .filter(Boolean);
      return {
        id: d.id,
        index: i,
        color: DAY_COLORS[i % DAY_COLORS.length],
        date: d.date || null,
        label: d.date ? fmtDate(d.date, locale, { weekday: 'short', day: 'numeric', month: 'short' }) : '',
        title: str(d.title),
        stops: assignments.map(toStop),
        notes,
      };
    });

  const unscheduled = (places || [])
    .filter((p) => !used.has(String(p.id)))
    .map((p) => ({ name: str(p.name) || t('untitledPlace'), lat: num(p.lat), lng: num(p.lng) }));

  const dayById = new Map(days.map((d) => [String(d.id), d]));
  const lodging = (Array.isArray(rawAccs) ? rawAccs : []).map((a) => {
    const p = (a.place && typeof a.place === 'object' ? a.place : null) || placeById.get(String(a.place_id)) || {};
    const start = dayById.get(String(a.start_day_id));
    const end = dayById.get(String(a.end_day_id));
    const nights = start && end && parseDate(start.date) && parseDate(end.date)
      ? Math.max(0, Math.round((parseDate(end.date) - parseDate(start.date)) / 86400000)) : null;
    return {
      name: str(a.place_name, a.name, p.name) || t('accommodation'),
      from: start ? start.label : fmtDate(str(a.check_in_date, a.start_date), locale, { day: 'numeric', month: 'short' }),
      to: end ? end.label : fmtDate(str(a.check_out_date, a.end_date), locale, { day: 'numeric', month: 'short' }),
      checkIn: fmtTime(str(a.check_in, a.check_in_time)),
      checkOut: fmtTime(str(a.check_out, a.check_out_time)),
      nights,
    };
  });

  const baseCurrency = str(trip.currency, currency) || 'EUR';
  const costs = rawCosts === null ? null : (Array.isArray(rawCosts) ? rawCosts : []).map((c) => ({
    name: str(c.name) || t('expense'),
    category: str(c.category, c.category_name) || t('other'),
    amount: Number(c.total_price) || 0,
    currency: (str(c.currency) || baseCurrency).toUpperCase(),
    persons: num(c.persons) > 0 ? num(c.persons) : null,
    note: str(c.note, c.notes),
  }));

  const start = parseDate(trip.start_date) || parseDate(days[0] && days[0].date);
  const end = parseDate(trip.end_date) || parseDate(days.length ? days[days.length - 1].date : null);
  let dateRange = '';
  if (start && end) {
    const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
    dateRange = `${fmtDate(start, locale, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })} – ${fmtDate(end, locale, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  } else if (start) dateRange = fmtDate(start, locale, { day: 'numeric', month: 'short', year: 'numeric' });
  const duration = start && end ? Math.round((end - start) / 86400000) + 1 : days.length || null;

  return {
    id: trip.id,
    title: str(trip.title, trip.name) || t('trip'),
    t,
    lang,
    description: str(trip.description),
    dateRange,
    duration,
    locale,
    timeZone,
    baseCurrency,
    days,
    unscheduled,
    lodging,
    costs,
  };
}

function costSummary(data) {
  if (!data.costs) return null;
  const byCurrency = new Map();
  for (const c of data.costs) {
    if (!byCurrency.has(c.currency)) byCurrency.set(c.currency, { currency: c.currency, total: 0, categories: new Map() });
    const g = byCurrency.get(c.currency);
    g.total += c.amount;
    g.categories.set(c.category, (g.categories.get(c.category) || 0) + c.amount);
  }
  return [...byCurrency.values()]
    .sort((a, b) => (a.currency === data.baseCurrency ? -1 : b.currency === data.baseCurrency ? 1 : b.total - a.total))
    .map((g) => ({
      currency: g.currency,
      total: g.total,
      formatted: fmtMoney(g.total, g.currency, data.locale),
      categories: [...g.categories.entries()].map(([name, total]) => ({ name, total, formatted: fmtMoney(total, g.currency, data.locale) })).sort((a, b) => b.total - a.total),
    }));
}

// ---------------------------------------------------------------- map model

const NICE_DEG = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 20, 30, 45];
const R = 6371008.8;
const mx = (lng) => (lng * Math.PI) / 180;
const my = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const unY = (y) => (Math.atan(Math.exp(y)) * 360) / Math.PI - 90;

/**
 * Project the trip onto a w×h Web-Mercator canvas. Pure geometry — rendered both by
 * the PDF writer and by the tab's live SVG preview.
 */
function buildMap(data, w, h, opts = {}) {
  const { minSpan = 0.004, pad = 36, labels = true, gridLabels = true } = opts;
  const pts = [];
  for (const d of data.days) for (const s of d.stops) if (validCoord(s.lat, s.lng)) pts.push(s);
  for (const s of data.unscheduled) if (validCoord(s.lat, s.lng)) pts.push(s);
  const t = data.t || translator('en');
  const legend = data.days.map((d) => ({ color: d.color, label: `${t('dayN', { n: d.index + 1 })}${d.label ? ' · ' + d.label : ''}`, count: d.stops.length }));
  if (!pts.length) return { w, h, empty: true, routes: [], markers: [], grid: [], scale: null, legend };

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    const X = mx(p.lng), Y = my(p.lat);
    x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
  }
  // minSpan (radians of Mercator x/y; 0.004 ≈ 25 km) keeps a single place from zooming to street level.
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const sx = Math.max(x1 - x0, minSpan), sy = Math.max(y1 - y0, minSpan);
  const k = Math.min((w - 2 * pad) / sx, (h - 2 * pad) / sy);
  const P = (lat, lng) => [w / 2 + (mx(lng) - cx) * k, h / 2 - (my(lat) - cy) * k];

  // Graticule: aim for ~5 lines across the wider axis.
  const lngSpan = ((w / k) * 180) / Math.PI;
  const step = NICE_DEG.find((s) => lngSpan / s <= 6) || 45;
  const lngMin = (((cx - w / 2 / k) * 180) / Math.PI), lngMax = (((cx + w / 2 / k) * 180) / Math.PI);
  const latMin = unY(cy - h / 2 / k), latMax = unY(cy + h / 2 / k);
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  const grid = [];
  for (let g = Math.ceil(lngMin / step) * step; g <= lngMax; g += step) {
    const x = P(0, g)[0];
    grid.push({ x1: x, y1: 0, x2: x, y2: h, label: gridLabels ? `${Math.abs(g).toFixed(decimals)}°${g < 0 ? 'W' : 'E'}` : '', lx: x + 3, ly: h - 4 });
  }
  for (let g = Math.ceil(latMin / step) * step; g <= latMax; g += step) {
    const y = P(g, 0)[1];
    grid.push({ x1: 0, y1: y, x2: w, y2: y, label: gridLabels ? `${Math.abs(g).toFixed(decimals)}°${g < 0 ? 'S' : 'N'}` : '', lx: 4, ly: y - 3 });
  }

  // Every element also keeps its lat/lng (ll) so the tab can re-project it while zooming.
  const routes = [], markers = [], links = [];
  let prevEnd = null, prevLL = null;
  for (const d of data.days) {
    const line = [], ll = [];
    d.stops.forEach((s, i) => {
      if (!validCoord(s.lat, s.lng)) return;
      const [x, y] = P(s.lat, s.lng);
      line.push([x, y]);
      ll.push([s.lat, s.lng]);
      markers.push({ x, y, lat: s.lat, lng: s.lng, color: d.color, n: i + 1, day: d.index + 1, label: s.name });
    });
    if (line.length > 1) routes.push({ color: d.color, points: line, ll });
    // Dashed "journey" link from where the previous day ended to where this one starts.
    if (line.length) {
      if (prevEnd && Math.hypot(prevEnd[0] - line[0][0], prevEnd[1] - line[0][1]) > 2) links.push({ points: [prevEnd, line[0]], ll: [prevLL, ll[0]] });
      prevEnd = line[line.length - 1];
      prevLL = ll[ll.length - 1];
    }
  }
  for (const s of data.unscheduled) {
    if (!validCoord(s.lat, s.lng)) continue;
    const [x, y] = P(s.lat, s.lng);
    markers.unshift({ x, y, lat: s.lat, lng: s.lng, color: FAINT, n: null, day: null, label: s.name });
  }

  // Scale bar: a round distance close to a fifth of the width.
  const mPerPt = (R * Math.cos(unY(cy) * Math.PI / 180)) / k;
  const target = (w / 5) * mPerPt;
  const mag = Math.pow(10, Math.floor(Math.log10(target)));
  const dist = [1, 2, 5, 10].map((f) => f * mag).filter((v) => v <= target).pop() || mag;
  const scale = { len: dist / mPerPt, label: dist >= 1000 ? `${dist / 1000} km` : `${dist} m` };

  return { w, h, empty: false, view: { cx, cy, k }, routes, links, markers, grid, scale, legend, showLabels: labels && markers.length <= 30 };
}

// ---------------------------------------------------------------- PDF layout

const SECTIONS = ['map', 'itinerary', 'lodging', 'costs'];

/**
 * @param opts.basemap  async (mapModel, { labelScale, measure, reserved }) => basemap|null —
 *                      vector background (see basemap.js); omitted → graticule only.
 */
async function renderPdf(data, opts = {}) {
  const sections = new Set((opts.sections || SECTIONS).filter((s) => SECTIONS.includes(s)));
  const t = data.t;
  const upper = (v) => v.toLocaleUpperCase(data.locale);
  const doc = new PdfDoc({ size: opts.paper === 'letter' ? 'letter' : 'a4', title: `${data.title} – ${t('tripReport')}` });
  doc.t = t;
  doc.upper = upper;
  const M = 42, W = doc.width - 2 * M, BOTTOM = doc.height - 48;
  let y = 0;

  const newPage = () => {
    doc.addPage();
    doc.fill(BRAND).rect(0, 0, doc.width, 6);
    doc.text(doc.fit(data.title, W - 120, 9, true), M, 28, { size: 9, bold: true, color: MUTED });
    doc.text(t('tripReport'), M + W, 28, { size: 9, color: FAINT, align: 'right' });
    doc.stroke(LINE).lineWidth(0.6).line(M, 38, M + W, 38);
    y = 60;
  };
  const ensure = (need) => { if (y + need > BOTTOM) { newPage(); return true; } return false; };
  const heading = (title, sub, need = 40) => {
    ensure(26 + need);
    y += 8;
    doc.fill(ACCENT).rect(M, y - 11, 3, 14);
    doc.text(title, M + 10, y, { size: 15, bold: true, color: INK });
    if (sub) doc.text(sub, M + W, y, { size: 9, color: MUTED, align: 'right' });
    y += 18;
  };

  // ---- cover header
  doc.addPage();
  const HEAD = 132;
  doc.fill(BRAND).rect(0, 0, doc.width, HEAD);
  doc.fill(ACCENT).rect(0, HEAD - 4, doc.width, 4);
  doc.text(upper(t('tripReport')), M, 40, { size: 8.5, bold: true, color: '#93c5fd' });
  const titleLines = doc.wrap(data.title, W, 26, true).slice(0, 2);
  titleLines.forEach((l, i) => doc.text(l, M, 72 + i * 28, { size: 26, bold: true, color: '#ffffff' }));
  const subtitle = [data.dateRange, data.duration ? t.n('nDays', data.duration) : ''].filter(Boolean).join('   ·   ');
  doc.text(subtitle || t('noDates'), M, 72 + titleLines.length * 28, { size: 10.5, color: '#cbd5e1' });
  doc.text(t('generated', { date: fmtDate(new Date(), data.locale, { day: 'numeric', month: 'short', year: 'numeric', ...(data.timeZone ? { timeZone: data.timeZone } : {}) }) }), M + W, 40, { size: 8.5, color: '#94a3b8', align: 'right' });
  y = HEAD + 24;

  // ---- stat tiles
  const stops = data.days.reduce((s, d) => s + d.stops.length, 0);
  const summary = costSummary(data);
  const stats = [
    [t('days'), String(data.days.length || data.duration || 0)],
    [t('plannedStops'), String(stops)],
    [t('places'), String(stops + data.unscheduled.length)],
    [t('totalCost'), summary && summary.length ? summary[0].formatted + (summary.length > 1 ? ' +' : '') : '—'],
  ];
  const gap = 10, tw = (W - gap * 3) / 4;
  stats.forEach(([label, value], i) => {
    const x = M + i * (tw + gap);
    doc.fill(SOFT).roundRect(x, y, tw, 52, 6);
    doc.text(doc.fit(upper(label), tw - 24, 7.5, true), x + 12, y + 18, { size: 7.5, bold: true, color: MUTED });
    doc.text(doc.fit(value, tw - 24, 15, true), x + 12, y + 40, { size: 15, bold: true, color: INK });
  });
  y += 52 + 20;

  if (data.description) {
    for (const l of doc.wrap(data.description, W, 9.5).slice(0, 4)) { doc.text(l, M, y, { size: 9.5, color: MUTED }); y += 13; }
    y += 8;
  }

  // ---- map
  if (sections.has('map')) {
    heading(t('mapOverview'));
    const mh = Math.max(260, Math.min(430, BOTTOM - y - 64));
    const map = buildMap(data, W, mh);
    drawMap(doc, map, M, y);
    y += mh + 12;
    // legend
    let lx = M;
    for (const item of map.legend) {
      const label = `${item.label} (${item.count})`;
      const iw = 14 + doc.measure(label, 8) + 14;
      if (lx + iw > M + W) { lx = M; y += 14; }
      if (ensure(14)) lx = M;
      doc.fill(item.color).circle(lx + 4, y - 3, 3.5);
      doc.text(label, lx + 12, y, { size: 8, color: MUTED });
      lx += iw;
    }
    if (data.unscheduled.some((p) => validCoord(p.lat, p.lng))) {
      const label = t('notScheduled');
      if (lx + 80 > M + W) { lx = M; y += 14; }
      doc.fill(FAINT).circle(lx + 4, y - 3, 3.5);
      doc.text(label, lx + 12, y, { size: 8, color: MUTED });
    }
    y += 22;
  }

  // ---- itinerary
  if (sections.has('itinerary')) {
    heading(t('itinerary'), `${t.n('nDays', data.days.length)} · ${t.n('nStops', stops)}`, sections.has('map') ? 150 : 60);
    if (!data.days.length) { doc.text(t('noDays'), M, y, { size: 10, color: MUTED }); y += 18; }
    const MINI_W = 150, MINI_H = 112;
    for (const d of data.days) {
      // A per-day detail map beside the stops — the overview is too coarse for multi-city trips.
      const mini = sections.has('map') && d.stops.some((s) => validCoord(s.lat, s.lng))
        ? buildMap({ days: [d], unscheduled: [] }, MINI_W, MINI_H, { minSpan: 0.0006, pad: 16, labels: false, gridLabels: false })
        : null;
      const CW = mini ? W - MINI_W - 14 : W; // stop column width
      ensure(mini ? 26 + MINI_H : 56);
      y += 6;
      const pill = upper(t('dayN', { n: d.index + 1 }));
      const pw = Math.max(46, doc.measure(pill, 8.5, true) + 14), lx = M + Math.max(56, pw + 10);
      doc.fill(d.color).roundRect(M, y - 13, pw, 18, 4);
      doc.text(pill, M + pw / 2, y, { size: 8.5, bold: true, color: '#ffffff', align: 'center' });
      doc.text(d.label || '', lx, y, { size: 11.5, bold: true, color: INK });
      const lw = doc.measure(d.label || '', 11.5, true);
      if (d.title) doc.text(doc.fit(d.title, CW - (lx - M) - 6 - lw, 10, false), lx + 6 + lw, y, { size: 10, color: MUTED });
      y += 16;
      const top = y, page = doc.pages.length;
      if (mini) drawMap(doc, mini, M + W - MINI_W, top - 8);
      if (!d.stops.length && !d.notes.length) { doc.text(t('nothingPlanned'), M + 56, y, { size: 9, color: FAINT }); y += 16; }
      d.stops.forEach((s, i) => {
        const meta = [s.category, s.address].filter(Boolean).join(' · ');
        const notes = s.notes ? doc.wrap(s.notes, CW - 60, 8.5).slice(0, 4) : [];
        ensure(18 + (meta ? 11 : 0) + notes.length * 11);
        y += 4;
        if (i < d.stops.length - 1) doc.stroke(LINE).lineWidth(1).line(M + 23, y + 2, M + 23, y + 14 + (meta ? 11 : 0) + notes.length * 11);
        doc.fill(d.color).circle(M + 23, y - 3.5, 7);
        doc.text(String(i + 1), M + 23, y - 0.5, { size: 7.5, bold: true, color: '#ffffff', align: 'center' });
        const time = s.time ? s.time + (s.endTime ? `–${s.endTime}` : '') : '';
        const tw = time ? doc.measure(time, 9) + 10 : 0;
        doc.text(doc.fit(s.name, CW - 56 - tw, 10, true), M + 56, y, { size: 10, bold: true, color: INK });
        if (time) doc.text(time, M + CW, y, { size: 9, color: MUTED, align: 'right' });
        y += 12;
        if (meta) { doc.text(doc.fit(meta, CW - 56, 8.5), M + 56, y, { size: 8.5, color: MUTED }); y += 11; }
        for (const l of notes) { doc.text(l, M + 56, y, { size: 8.5, color: FAINT }); y += 11; }
        y += 2;
      });
      for (const note of d.notes) {
        const lines = doc.wrap(note, CW - 66, 8.5).slice(0, 3);
        ensure(lines.length * 11 + 8);
        y += 2;
        lines.forEach((l, i) => { doc.text((i ? '' : '• ') + l, M + 56 + (i ? 7 : 0), y, { size: 8.5, color: MUTED }); y += 11; });
      }
      // Keep the block at least as tall as its map (when we're still on the map's page).
      if (mini && doc.pages.length === page) y = Math.max(y, top - 8 + MINI_H + 4);
      y += 6;
      doc.stroke(LINE).lineWidth(0.5).line(M, y, M + W, y);
      y += 8;
    }
    if (data.unscheduled.length) {
      ensure(40);
      y += 6;
      doc.text(t('notYetScheduled', { n: data.unscheduled.length }), M, y, { size: 10, bold: true, color: INK });
      y += 14;
      for (const l of doc.wrap(data.unscheduled.map((p) => p.name).join('  ·  '), W, 9)) {
        ensure(12); doc.text(l, M, y, { size: 9, color: MUTED }); y += 12;
      }
      y += 8;
    }
  }

  // ---- lodging
  if (sections.has('lodging') && data.lodging.length) {
    heading(t('accommodation'), t.n('nStays', data.lodging.length), 18 * Math.min(3, data.lodging.length + 1));
    table(doc, {
      cols: [
        { title: t('where'), w: W * 0.42, get: (r) => r.name, bold: true },
        { title: t('checkIn'), w: W * 0.2, get: (r) => [r.from, r.checkIn].filter(Boolean).join(' ') },
        { title: t('checkOut'), w: W * 0.2, get: (r) => [r.to, r.checkOut].filter(Boolean).join(' ') },
        { title: t('nights'), w: W * 0.18, get: (r) => (r.nights === null ? '' : String(r.nights)), align: 'right' },
      ],
      rows: data.lodging,
      x: M,
      get y() { return y; }, set y(v) { y = v; },
      ensure, newPage,
    });
    y += 14;
  }

  // ---- costs
  if (sections.has('costs')) {
    heading(t('costs'), data.costs ? t.n('nExpenses', data.costs.length) : '', 80);
    if (!data.costs) {
      doc.text(t('costsOffPdf'), M, y, { size: 9.5, color: MUTED });
      y += 18;
    } else if (!data.costs.length) {
      doc.text(t('noExpenses'), M, y, { size: 9.5, color: MUTED });
      y += 18;
    } else {
      for (const g of summary) {
        ensure(40 + g.categories.length * 18);
        doc.text(summary.length > 1 ? t('totalCur', { cur: g.currency }) : t('total'), M, y, { size: 9, bold: true, color: MUTED });
        doc.text(g.formatted, M + W, y + 2, { size: 16, bold: true, color: INK, align: 'right' });
        y += 18;
        const max = Math.max(...g.categories.map((c) => c.total), 1);
        const labelW = 130, amtW = 90, barW = W - labelW - amtW - 10;
        g.categories.forEach((c, i) => {
          doc.text(doc.fit(c.name, labelW - 8, 9), M, y + 9, { size: 9, color: INK });
          doc.fill(SOFT).roundRect(M + labelW, y + 1, barW, 10, 3);
          doc.fill(DAY_COLORS[i % DAY_COLORS.length]).roundRect(M + labelW, y + 1, Math.max(3, (barW * Math.max(0, c.total)) / max), 10, 3);
          const pct = g.total > 0 ? Math.round((c.total / g.total) * 100) : 0;
          doc.text(`${c.formatted}  ${pct}%`, M + W, y + 9, { size: 8.5, color: MUTED, align: 'right' });
          y += 16;
        });
        y += 12;
      }
      const rows = data.costs.slice().sort((a, b) => a.category.localeCompare(b.category) || b.amount - a.amount);
      table(doc, {
        cols: [
          { title: t('item'), w: W * 0.40, get: (r) => r.name, bold: true },
          { title: t('category'), w: W * 0.22, get: (r) => r.category },
          { title: t('persons'), w: W * 0.15, get: (r) => (r.persons ? String(r.persons) : ''), align: 'right' },
          { title: t('amount'), w: W * 0.23, get: (r) => fmtMoney(r.amount, r.currency, data.locale), align: 'right' },
        ],
        rows,
        total: summary.map((g) => g.formatted).join('  +  '),
        x: M,
        get y() { return y; }, set y(v) { y = v; },
        ensure, newPage,
      });
    }
  }

  // ---- footers
  const total = doc.pages.length;
  for (let i = 0; i < total; i++) {
    doc.setPage(i);
    doc.stroke(LINE).lineWidth(0.6).line(M, doc.height - 34, M + W, doc.height - 34);
    doc.text(t('madeWith'), M, doc.height - 20, { size: 7.5, color: FAINT });
    doc.text(t('pageOf', { n: i + 1, total }), M + W, doc.height - 20, { size: 7.5, color: FAINT, align: 'right' });
  }

  // ---- basemaps: fetched after layout, then dropped into the slots drawMap reserved.
  const slots = doc.mapSlots || [];
  const bases = await Promise.all(slots.map((s) => (opts.basemap
    ? opts.basemap(s.map, { labelScale: s.small ? 0.8 : 1, scale: s.small ? 2.5 : 2, measure: (txt, size, bold) => doc.measure(txt, size, bold), reserved: s.reserved }).catch(() => null)
    : null)));
  slots.forEach((s, i) => {
    const b = bases[i];
    const ops = b ? capture(doc, () => { paintBasemap(doc, b, s.ox, s.oy, s.map.w, s.map.h); s.attribution(b.attribution); }) : s.grid;
    s.page[s.index] = ops.join('\n');
  });
  return doc;
}

/** Draw basemap geometry (map-local points) at the map's page origin. */
function paintBasemap(doc, b, ox, oy, w, h) {
  if (b.raster) { doc.ops.push(...doc.imageOps(b.raster, ox, oy, w, h)); return; }
  const shift = (rings) => rings.map((r) => r.map(([x, y]) => [ox + x, oy + y]));
  doc.fill(b.background).rect(ox, oy, w, h);
  for (const l of b.layers) {
    if (l.kind === 'fill') doc.fill(l.color).path(shift(l.rings), 'fill');
    else { doc.stroke(l.color).lineWidth(l.width).dash(...(l.dash || [0])); doc.path(shift(l.rings), 'stroke'); }
  }
  doc.dash(0);
  for (const l of b.labels) doc.text(l.text, ox + l.x, oy + l.y, { size: l.size, bold: l.bold, color: l.color, align: 'center', halo: b.halo || '#ffffff', haloWidth: l.size * 0.32 });
}

/** Capture the ops a drawing callback emits, without adding them to the page. */
function capture(doc, fn) {
  const saved = doc.ops;
  doc.ops = [];
  fn();
  const out = doc.ops;
  doc.ops = saved;
  return out;
}

function drawMap(doc, map, ox, oy) {
  const { w, h } = map;
  doc.fill('#eef3f8').roundRect(ox, oy, w, h, 8);
  doc.save().clip(ox, oy, w, h, 8);
  if (map.empty) {
    doc.text(doc.t('noCoords'), ox + w / 2, oy + h / 2, { size: 11, bold: true, color: MUTED, align: 'center' });
    doc.text(doc.t('addPlaces'), ox + w / 2, oy + h / 2 + 16, { size: 9, color: FAINT, align: 'center' });
  } else {
    // Reserve a slot: renderPdf fills it with the vector basemap, or with this graticule
    // when the basemap is off/unreachable.
    const grid = capture(doc, () => {
      doc.stroke('#d6dee8').lineWidth(0.5);
      for (const g of map.grid) doc.line(ox + g.x1, oy + g.y1, ox + g.x2, oy + g.y2);
      for (const g of map.grid) if (g.label && g.lx < w - 28 && g.ly > 10) doc.text(g.label, ox + g.lx, oy + g.ly, { size: 6, color: '#94a3b8' });
    });
    const small = w < 200;
    // Drawn once the basemap (and so its source's credit line) is known.
    const attribution = (text) => {
      const fs = small ? 4.5 : 6, aw = doc.measure(text, fs) + 6;
      doc.fill('#ffffff').rect(ox, oy + h - fs - 5, aw, fs + 5);
      doc.text(text, ox + 3, oy + h - 3.5, { size: fs, color: MUTED });
    };
    // Labels keep clear of route markers, the scale bar and the attribution.
    const reserved = map.markers.map((m) => [m.x - 10, m.y - 10, m.x + 10, m.y + 10]);
    // Scale bar: the first corner free of route markers (bottom-left holds the attribution).
    if (map.scale) {
      const bw = map.scale.len + 22, bh = 24;
      const corners = small
        ? [[w - bw, 0], [0, 0], [w - bw, h - bh - 2]]
        : [[w - bw, h - bh - 4], [w - bw, 0], [0, 0]];
      const free = ([x, y]) => !map.markers.some((m) => m.x > x - 10 && m.x < x + bw + 10 && m.y > y - 10 && m.y < y + bh + 10);
      const [bx, by] = corners.find(free) || corners[0];
      map.scaleBox = [bx, by, bx + bw, by + bh];
      reserved.push(map.scaleBox);
    }
    reserved.push([0, h - 14, doc.measure(ATTRIBUTION, small ? 4.5 : 6) + 8, h]);
    (doc.mapSlots = doc.mapSlots || []).push({ map, ox, oy, small, grid, attribution, reserved, page: doc.ops, index: doc.ops.length });
    doc.ops.push('');
    doc.stroke('#94a3b8').lineWidth(1.2).dash(4, 3);
    for (const l of map.links || []) doc.polyline(l.points.map(([x, y]) => [ox + x, oy + y]));
    doc.dash(0);
    for (const r of map.routes) {
      doc.stroke('#ffffff').lineWidth(4.5).polyline(r.points.map(([x, y]) => [ox + x, oy + y]));
      doc.stroke(r.color).lineWidth(2).polyline(r.points.map(([x, y]) => [ox + x, oy + y]));
    }
    const boxes = [];
    for (const m of map.markers) {
      const x = ox + m.x, y = oy + m.y;
      if (m.n === null) { doc.fill('#ffffff').circle(x, y, 4.5); doc.fill(m.color).circle(x, y, 3.2); continue; }
      doc.fill('#ffffff').circle(x, y, 8.2);
      doc.fill(m.color).circle(x, y, 6.8);
      doc.text(String(m.n), x, y + 2.6, { size: m.n > 9 ? 6 : 7, bold: true, color: '#ffffff', align: 'center' });
    }
    if (map.showLabels) {
      for (const m of map.markers.slice().reverse()) {
        const label = doc.fit(m.label, 110, 7, true);
        const lw = doc.measure(label, 7, true) + 6;
        const bx = ox + m.x + 10, by = oy + m.y - 6;
        const box = [bx, by, bx + lw, by + 11];
        if (box[2] > ox + w - 2 || boxes.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
        boxes.push(box);
        doc.fill('#ffffff').roundRect(bx, by, lw, 11, 2.5);
        doc.text(label, bx + 3, by + 8, { size: 7, bold: true, color: INK });
      }
    }
    if (map.scale) {
      const sx = ox + map.scaleBox[0] + 8, sy = oy + map.scaleBox[1] + 20;
      doc.fill('#ffffff').roundRect(sx - 6, sy - 14, map.scale.len + 12, 20, 3);
      doc.stroke(INK).lineWidth(1.2).polyline([[sx, sy - 3], [sx, sy], [sx + map.scale.len, sy], [sx + map.scale.len, sy - 3]]);
      doc.text(map.scale.label, sx + map.scale.len / 2, sy - 5, { size: 6.5, bold: true, color: INK, align: 'center' });
    }
  }
  doc.restore();
  doc.stroke('#d6dee8').lineWidth(0.8).roundRect(ox, oy, w, h, 8, 'stroke');
}

function table(doc, t) {
  const RH = 18;
  const header = () => {
    doc.fill(SOFT).rect(t.x, t.y, t.cols.reduce((s, c) => s + c.w, 0), RH);
    let x = t.x;
    for (const c of t.cols) {
      doc.text(doc.fit(doc.upper(c.title), c.w - 16, 7.5, true), c.align === 'right' ? x + c.w - 8 : x + 8, t.y + 12, { size: 7.5, bold: true, color: MUTED, align: c.align || 'left' });
      x += c.w;
    }
    t.y += RH;
  };
  t.ensure(RH * 3);
  header();
  for (const r of t.rows) {
    if (t.ensure(RH)) header();
    let x = t.x;
    for (const c of t.cols) {
      const v = doc.fit(c.get(r), c.w - 16, 9, !!c.bold);
      doc.text(v, c.align === 'right' ? x + c.w - 8 : x + 8, t.y + 12, { size: 9, bold: !!c.bold, color: c.bold ? INK : '#374151', align: c.align || 'left' });
      x += c.w;
    }
    t.y += RH;
    doc.stroke(LINE).lineWidth(0.5).line(t.x, t.y, x, t.y);
  }
  if (t.total) {
    t.ensure(RH + 4);
    const tw = t.cols.reduce((s, c) => s + c.w, 0);
    doc.text(doc.t('total'), t.x + 8, t.y + 14, { size: 9.5, bold: true, color: INK });
    doc.text(doc.fit(t.total, tw - 60, 9.5, true), t.x + tw - 8, t.y + 14, { size: 9.5, bold: true, color: INK, align: 'right' });
    t.y += RH + 4;
  }
}

function fileName(data) {
  const date = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(data.timeZone ? { timeZone: data.timeZone } : {}) }).format(new Date());
  // Keep letters of every script; drop only what file systems reject.
  const clean = (v) => v.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().replace(/\s+/g, ' ');
  const safe = clean(data.title).slice(0, 80) || data.t('trip');
  return `${safe} - ${clean(data.t('tripReport'))} ${date}.pdf`;
}

module.exports = { loadTrip, buildMap, renderPdf, costSummary, fileName, SECTIONS };
