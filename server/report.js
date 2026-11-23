'use strict';
const { PdfDoc } = require('./pdf');
const { covers: fontCovers } = require('./font');
const { translator } = require('./i18n');
const md = require('./markdown');

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

// Distances, heights and durations in the user's locale ("12.4 km", "540 m", "3 h 20 min").
function fmtUnit(v, unit, locale, digits = 0) {
  try {
    const s = new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: digits }).format(v);
    if (covers(s)) return s;
  } catch { /* unknown locale/unit → plain */ }
  return `${v.toFixed(digits)} ${{ kilometer: 'km', meter: 'm', hour: 'h', minute: 'min', 'kilometer-per-hour': 'km/h' }[unit] || unit}`;
}
const fmtKm = (km, locale) => (km < 1 ? fmtUnit(Math.round(km * 1000), 'meter', locale) : fmtUnit(km, 'kilometer', locale, km < 100 ? 1 : 0));
function fmtDuration(min, locale) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return [h ? fmtUnit(h, 'hour', locale) : '', m || !h ? fmtUnit(m, 'minute', locale) : ''].filter(Boolean).join(' ');
}

const ELEVATION_NOISE_M = 5; // same jitter filter TREK uses, so ascent/descent match the app
const haversine = (a, b) => {
  const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
  const c = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(Math.min(1, c)), Math.sqrt(Math.max(0, 1 - c)));
};
/** Every n-th item so at most `max` remain, always keeping the last. */
const thin = (arr, max) => {
  if (arr.length <= max) return arr;
  const step = (arr.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => arr[Math.round(i * step)]);
};

/**
 * A tour's track as TREK stores it: JSON `[[lat, lng], …]` or `[[lat, lng, ele], …]`.
 * Returns its metrics (as TREK counts them) plus thinned copies for drawing; null when unusable.
 */
function parseTrack(raw) {
  let a = raw;
  if (typeof raw === 'string') { try { a = JSON.parse(raw); } catch { return null; } }
  if (!Array.isArray(a)) return null;
  const pts = a.filter((q) => Array.isArray(q) && (q.length === 2 || q.length === 3) && q.every((v) => typeof v === 'number' && Number.isFinite(v)) && Math.abs(q[0]) <= 90 && Math.abs(q[1]) <= 180);
  if (pts.length < 2) return null;
  const hasEle = pts.every((q) => q.length === 3);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
  const out = { km: cum[cum.length - 1] / 1000, gain: null, loss: null, minEle: null, maxEle: null, profile: null, line: thin(pts, 400).map((q) => [q[0], q[1]]) };
  out.loop = haversine(pts[0], pts[pts.length - 1]) < 60;
  if (hasEle) {
    let gain = 0, loss = 0, ref = pts[0][2], lo = ref, hi = ref;
    for (const q of pts) {
      lo = Math.min(lo, q[2]); hi = Math.max(hi, q[2]);
      const d = q[2] - ref;
      if (d >= ELEVATION_NOISE_M) gain += d; else if (d <= -ELEVATION_NOISE_M) loss -= d; else continue;
      ref = q[2];
    }
    Object.assign(out, { gain, loss, minEle: lo, maxEle: hi, profile: thin(pts.map((q, i) => [cum[i], q[2]]), 160) });
  }
  return out;
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
    // A tour on a day is a stop whose place carries a track (TREK's tour_route_geometry).
    const track = parseTrack(a.tour_route_geometry || p.route_geometry || (placeById.get(String(a.place_id)) || {}).route_geometry);
    const lat = num(p.lat ?? p.latitude), lng = num(p.lng ?? p.lon ?? p.longitude);
    return {
      placeId: p.id ?? a.place_id ?? null,
      name: str(p.name, a.name) || t('untitledPlace'),
      // A tour without its own coordinates sits where its track starts.
      lat: track && !validCoord(lat, lng) ? track.line[0][0] : lat,
      lng: track && !validCoord(lat, lng) ? track.line[0][1] : lng,
      track,
      duration: num(p.duration_minutes) > 0 ? num(p.duration_minutes) : null,
      // The time set for this day (assignment_time) wins over the place's general one.
      time: fmtTime(str(a.assignment_time, a.place_time, p.place_time, a.start_time, a.time)),
      endTime: fmtTime(str(a.assignment_end_time, a.end_time, p.end_time)),
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
      // Day notes: the day's own note, then its note items (with their time, when set).
      const notes = [str(d.notes), ...(Array.isArray(d.notes_items) ? d.notes_items : [])
        .map((x) => [str(x && x.time).slice(0, 24), str(x && x.text, x && x.content, x && x.title, typeof x === 'string' ? x : '')])
        .map(([time, text]) => (text && time ? `${time}  ${text}` : text))]
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
    .map((p) => ({ placeId: p.id, name: str(p.name) || t('untitledPlace'), lat: num(p.lat), lng: num(p.lng), track: parseTrack(p.route_geometry), duration: num(p.duration_minutes) > 0 ? num(p.duration_minutes) : null }));

  // Tours: every track on the trip once, with the days it is planned on (a multi-day tour has several).
  const tours = [];
  const tourByPlace = new Map();
  const addTour = (s, d) => {
    const key = s.placeId === null || s.placeId === undefined ? s : String(s.placeId);
    let tour = tourByPlace.get(key);
    if (!tour) {
      tour = { key: s.placeId === null || s.placeId === undefined ? `n${tours.length}` : String(s.placeId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || `n${tours.length}`, name: s.name, color: d ? d.color : FAINT, days: [], time: s.time || '', endTime: s.endTime || '', category: s.category || '', notes: s.notes || '', track: s.track, lat: s.lat, lng: s.lng,
        duration: s.duration || (toMin(s.time) !== null && toMin(s.endTime) > toMin(s.time) ? toMin(s.endTime) - toMin(s.time) : null) };
      tourByPlace.set(key, tour);
      tours.push(tour);
    }
    if (d && !tour.days.includes(d.index)) tour.days.push(d.index);
  };
  for (const d of days) for (const st of d.stops) if (st.track) addTour(st, d);
  for (const u of unscheduled) if (u.track) addTour(u, null);
  // Positions: the trip's own places that lie on a tour's route (within ~200 m), in route order.
  // TREK doesn't hand plugins a tour's waypoints, so these are what can be named along it.
  const spots = [...days.flatMap((d) => d.stops), ...unscheduled].filter((p) => !p.track && validCoord(p.lat, p.lng));
  for (const tour of tours) {
    const seen = new Set();
    tour.positions = spots
      .map((p) => {
        let best = Infinity, at = 0;
        tour.track.line.forEach((q, i) => { const dist = haversine([p.lat, p.lng], q); if (dist < best) { best = dist; at = i; } });
        return { name: p.name, lat: p.lat, lng: p.lng, at, best };
      })
      .filter((p) => p.best <= 200 && !seen.has(p.name) && seen.add(p.name))
      .sort((a, b) => a.at - b.at)
      .slice(0, 9);
  }

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
    generatedAt: new Date(), // one instant for the cover line and the file name
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
    tours,
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
  // opts.view: an explicit { cx, cy, k } (the user's zoom from the tab) instead of fit-to-stops.
  const { minSpan = 0.004, pad = 36, labels = true, gridLabels = true, view = null } = opts;
  const pts = [];
  // Tour tracks count toward the fitted area, so a hike is shown whole, not just its start.
  const add = (s) => { if (validCoord(s.lat, s.lng)) pts.push(s); if (s.track) for (const q of s.track.line) pts.push({ lat: q[0], lng: q[1] }); };
  for (const d of data.days) for (const s of d.stops) add(s);
  for (const s of data.unscheduled) add(s);
  const t = data.t || translator('en');
  const legend = data.days.map((d) => ({ color: d.color, label: `${t('dayN', { n: d.index + 1 })}${d.label ? ' · ' + d.label : ''}`, count: d.stops.length }));
  if (!pts.length) return { w, h, empty: true, routes: [], tracks: [], markers: [], grid: [], scale: null, legend };

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    const X = mx(p.lng), Y = my(p.lat);
    x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
  }
  // minSpan (radians of Mercator x/y; 0.004 ≈ 25 km) keeps a single place from zooming to street level.
  const sx = Math.max(x1 - x0, minSpan), sy = Math.max(y1 - y0, minSpan);
  const cx = view ? view.cx : (x0 + x1) / 2, cy = view ? view.cy : (y0 + y1) / 2;
  const k = view ? view.k : Math.min((w - 2 * pad) / sx, (h - 2 * pad) / sy);
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
  const routes = [], tracks = [], markers = [], links = [];
  const addTrack = (s, color) => tracks.push({ color, points: s.track.line.map(([la, ln]) => P(la, ln)), ll: s.track.line });
  let prevEnd = null, prevLL = null;
  for (const d of data.days) {
    // The day's straight stop-to-stop line; a tour interrupts it: the line runs to where
    // the track starts and on from where it ends, and the track itself is drawn as recorded.
    let line = [], ll = [], first = null, firstLL = null, last = null, lastLL = null;
    const flush = () => { if (line.length > 1) routes.push({ color: d.color, points: line, ll }); line = []; ll = []; };
    d.stops.forEach((s, i) => {
      if (!validCoord(s.lat, s.lng)) return;
      const [x, y] = P(s.lat, s.lng);
      if (!opts.ends) markers.push({ x, y, lat: s.lat, lng: s.lng, color: d.color, n: i + 1, day: d.index + 1, label: s.name });
      const a = s.track ? s.track.line[0] : [s.lat, s.lng], b = s.track ? s.track.line[s.track.line.length - 1] : a;
      line.push(P(a[0], a[1])); ll.push(a);
      if (!first) { first = line[line.length - 1]; firstLL = a; }
      if (s.track) {
        addTrack(s, d.color);
        flush();
        line.push(P(b[0], b[1])); ll.push(b);
        // opts.ends (a tour's own map): mark start and finish instead of numbering the stop.
        if (opts.ends) for (const q of s.track.loop ? [a] : [a, b]) { const [qx, qy] = P(q[0], q[1]); markers.push({ x: qx, y: qy, lat: q[0], lng: q[1], color: d.color, n: null, day: d.index + 1, label: s.name }); }
      }
      last = line[line.length - 1]; lastLL = ll[ll.length - 1];
    });
    flush();
    // Dashed "journey" link from where the previous day ended to where this one starts.
    if (first) {
      if (prevEnd && Math.hypot(prevEnd[0] - first[0], prevEnd[1] - first[1]) > 2) links.push({ points: [prevEnd, first], ll: [prevLL, firstLL] });
      prevEnd = last;
      prevLL = lastLL;
    }
  }
  for (const s of data.unscheduled) {
    if (s.track) addTrack(s, FAINT);
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

  return { w, h, empty: false, view: { cx, cy, k }, routes, tracks, links, markers, grid, scale, legend, showLabels: labels && markers.length <= 30 };
}

// "12.4 km · ↑ 540 m · ↓ 520 m" (arrows only when the fonts can draw them).
function trackLine(track, locale) {
  const up = covers('↑') ? '↑ ' : '+', down = covers('↓') ? '↓ ' : '−';
  return [fmtKm(track.km, locale), track.gain !== null ? up + fmtUnit(Math.round(track.gain), 'meter', locale) : '', track.loss !== null ? down + fmtUnit(Math.round(track.loss), 'meter', locale) : ''].filter(Boolean).join(' · ');
}
/** When a tour is planned and its figures, worded for the PDF and for the tab's preview. */
function tourInfo(data, tour, detailed) {
  const t = data.t, tr = tour.track, L = data.locale;
  const when = tour.days.length
    ? [tour.days.map((i) => t('dayN', { n: i + 1 })).join(', '), tour.days.length === 1 ? data.days[tour.days[0]].label : '', tour.time ? tour.time + (tour.endTime ? `–${tour.endTime}` : '') : ''].filter(Boolean).join(' · ')
    : t('notScheduled');
  const speed = tour.duration ? tr.km / (tour.duration / 60) : null;
  const figs = [
    [t('distance'), fmtKm(tr.km, L)],
    tr.gain !== null ? [t('ascent'), fmtUnit(Math.round(tr.gain), 'meter', L)] : null,
    tr.loss !== null ? [t('descent'), fmtUnit(Math.round(tr.loss), 'meter', L)] : null,
    tour.duration ? [t('duration'), fmtDuration(tour.duration, L)] : null,
    detailed && speed ? [t('avgSpeed'), fmtUnit(speed, 'kilometer-per-hour', L, 1)] : null,
    tr.maxEle !== null ? [t('highest'), fmtUnit(Math.round(tr.maxEle), 'meter', L)] : null,
    tr.minEle !== null ? [t('lowest'), fmtUnit(Math.round(tr.minEle), 'meter', L)] : null,
  ].filter(Boolean);
  return { when, figs };
}
/** A tour's own map: its track with start and finish, and the named positions along it. */
function tourMap(data, tour, w, h, opts = {}) {
  const t = data.t, tr = tour.track;
  const day = { index: tour.days.length ? tour.days[0] : 0, color: tour.color, label: '', stops: [{ name: tour.name, lat: tour.lat, lng: tour.lng, track: tr }] };
  // opts.view: the zoom the user framed for this tour in the tab. Ignored when the tour is
  // nowhere near it (the trip's tours changed since it was saved).
  let view = opts.view || null;
  if (view) {
    const x = w / 2 + (mx(tr.line[0][1]) - view.cx) * view.k, y = h / 2 - (my(tr.line[0][0]) - view.cy) * view.k;
    if (x < -w || x > 2 * w || y < -h || y > 2 * h) view = null;
  }
  const map = buildMap({ days: [day], unscheduled: [], t }, w, h, { minSpan: 0.0004, pad: opts.pad || 18, labels: false, gridLabels: false, ends: true, view });
  if (map.empty) return map;
  const P = (lat, lng) => [w / 2 + (mx(lng) - map.view.cx) * map.view.k, h / 2 - (my(lat) - map.view.cy) * map.view.k];
  const ends = map.markers.splice(0); // start (and finish) from buildMap
  ends[0].label = tr.loop ? `${t('start')} / ${t('finish')}` : t('start');
  if (ends[1]) ends[1].label = t('finish');
  for (const p of tour.positions || []) { const [x, y] = P(p.lat, p.lng); map.markers.push({ x, y, lat: p.lat, lng: p.lng, color: INK, n: null, day: null, label: p.name }); }
  map.markers.push(...ends);
  for (const m of map.markers) m.title = m.label; // the tab's tooltip: just the name
  map.showLabels = !!opts.labels;
  return map;
}

// A round step (1, 2, 5 × 10ⁿ) that splits `span` into at most `max` parts.
function niceStep(span, max) {
  const raw = Math.max(span, 1e-9) / max, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 5, 10].map((f) => f * mag).find((v) => v >= raw);
}
/** Elevation over distance in a w×h box; opts.grid adds height lines and distance ticks every opts.step km. */
function drawProfile(doc, tr, color, x, y, w, h, opts = {}) {
  const cx0 = x + 26, cw = w - 26, cy0 = y, ch = h - 12;
  const span = Math.max(tr.maxEle - tr.minEle, 20), lo = tr.minEle - span * 0.08, hi = tr.maxEle + span * 0.08;
  const total = tr.profile[tr.profile.length - 1][0] || 1;
  const pt = ([dist, ele]) => [cx0 + (dist / total) * cw, cy0 + ch - ((ele - lo) / (hi - lo)) * ch];
  const line = tr.profile.map(pt);
  const label = (txt, lx, ly, align) => doc.text(txt, lx, ly, { size: 6.5, color: FAINT, align });
  if (opts.grid) {
    const es = niceStep(hi - lo, 4);
    doc.stroke(LINE).lineWidth(0.5);
    for (let e = Math.ceil(lo / es) * es; e <= hi; e += es) {
      const gy = pt([0, e])[1];
      doc.line(cx0, gy, cx0 + cw, gy);
      label(String(Math.round(e)), cx0 - 4, gy + 2.5, 'right');
    }
  }
  doc.fill(tint(color, 0.82)).path([[...line, [cx0 + cw, cy0 + ch], [cx0, cy0 + ch]]]);
  doc.stroke(color).lineWidth(1.2).polyline(line);
  doc.stroke(opts.grid ? MUTED : LINE).lineWidth(0.6).line(cx0, cy0 + ch, cx0 + cw, cy0 + ch);
  if (opts.grid) {
    for (let d = opts.step; d * 1000 < total - opts.step * 250; d += opts.step) {
      const gx = cx0 + ((d * 1000) / total) * cw;
      doc.stroke(MUTED).lineWidth(0.6).line(gx, cy0 + ch, gx, cy0 + ch + 3);
      label(String(Math.round(d * 10) / 10), gx, cy0 + ch + 10, 'center');
    }
  } else {
    label(String(Math.round(tr.maxEle)), cx0 - 4, pt([0, tr.maxEle])[1] + 2.5, 'right');
    label(String(Math.round(tr.minEle)), cx0 - 4, pt([0, tr.minEle])[1] + 2.5, 'right');
  }
  label('0', cx0, cy0 + ch + 10, 'left');
  label(fmtKm(tr.km, opts.locale), cx0 + cw, cy0 + ch + 10, 'right');
}

/**
 * A note (Markdown or plain) laid out for the PDF: [{ text, x, bold, bullet?, bx? }] with x
 * relative to the note's left edge. List items hang under their bullet; levels indent.
 */
function noteLines(doc, src, width, size, max = Infinity) {
  const out = [];
  const box = { '☐': covers('☐') ? '☐' : '–', '☑': covers('☑') ? '☑' : '✓' };
  for (const b of md.blocks(src)) {
    const bullet = box[b.bullet] || b.bullet;
    const indent = b.level * 10, hang = bullet ? doc.measure(bullet, size, false) + 4 : 0;
    doc.wrap(b.text, width - indent - hang, size, b.bold).forEach((text, i) => {
      out.push({ text, x: indent + hang, bold: b.bold, bullet: i === 0 && bullet ? bullet : '', bx: indent });
    });
    if (out.length >= max) break;
  }
  if (out.length > max) { out.length = max; out[max - 1].text = doc.fit(out[max - 1].text + ' …', width - out[max - 1].x, size, out[max - 1].bold); }
  return out;
}
// A colour mixed toward white (0 = unchanged, 1 = white), for chart fills.
const tint = (hex, f) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - f) + 255 * f).toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------- PDF layout

const SECTIONS = ['map', 'timeline', 'itinerary', 'tours', 'lodging', 'costs'];
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? Math.min(24 * 60, +m[1] * 60 + +m[2]) : null; };

/**
 * @param opts.basemap  async (mapModel, { labelScale, measure, reserved }) => basemap|null —
 *                      vector background (see basemap.js); omitted → graticule only.
 */
// The tab's preview map size; a zoom saved there is rescaled so the same area fits a PDF map.
const PREVIEW = [640, 380];
const fromPreview = (v, w, h) => (v ? { cx: v[0], cy: v[1], k: v[2] * Math.min(w / PREVIEW[0], h / PREVIEW[1]) } : null);

/**
 * @param opts.tourDetail  'full' = large map, profile with grid and full notes per tour; else compact.
 * @param opts.views  { all: [cx, cy, k], 'd<dayId>': [...], 't<tourKey>': [...] } — zoom states
 *                    from the tab (overview / per day / per tour); views not listed fit their content.
 */
async function renderPdf(data, opts = {}) {
  const views = opts.views || {};
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
  doc.text(t('generated', { date: new Intl.DateTimeFormat(data.locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', ...(data.timeZone ? { timeZone: data.timeZone } : {}) }).format(data.generatedAt || new Date()) }), M + W, 40, { size: 8.5, color: '#94a3b8', align: 'right' });
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
    // The whole intro, wrapped (keeping its line breaks) and continued on the next page if needed.
    for (const l of noteLines(doc, data.description, W, 9.5)) { ensure(13); if (l.bullet) doc.text(l.bullet, M + l.bx, y, { size: 9.5, color: MUTED }); doc.text(l.text, M + l.x, y, { size: 9.5, bold: l.bold, color: l.bold ? INK : MUTED }); y += 13; }
    y += 8;
  }

  // ---- map
  if (sections.has('map')) {
    heading(t('mapOverview'), '', 260 + 36); // heading + smallest map + legend, or a new page
    const mh = Math.max(260, Math.min(430, BOTTOM - y - 64));
    const map = buildMap(data, W, mh, { view: fromPreview(views.all, W, mh) });
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

  // ---- timeline: each day's stops on an hour axis.
  if (sections.has('timeline') && data.days.length) {
    heading(t('timeline'), data.dateRange, 90);
    const LW = 78, GX = M + LW, GW = W - LW, n = data.days.length;

    // Hour grid: the planned stops' times (an open-ended stop runs until the next one, 1 h at most).
    const rows = data.days.map((d) => {
      const timed = [], loose = [];
      d.stops.forEach((s, i) => { const a = toMin(s.time); if (a === null) loose.push(s.name); else timed.push({ i, name: s.name, a, e: toMin(s.endTime) }); });
      timed.sort((p, q) => p.a - q.a);
      timed.forEach((s, k) => {
        const next = timed[k + 1] ? timed[k + 1].a : 24 * 60;
        if (s.e === null || s.e <= s.a) s.e = Math.min(s.a + 60, Math.max(next, s.a + 30));
      });
      return { d, timed, loose };
    });
    const all = rows.flatMap((r) => r.timed);
    let h0 = 8, h1 = 20;
    if (all.length) {
      h0 = Math.max(0, Math.min(h0, Math.floor(Math.min(...all.map((s) => s.a)) / 60)));
      h1 = Math.min(24, Math.max(h1, Math.ceil(Math.max(...all.map((s) => s.e)) / 60)));
    }
    const step = h1 - h0 > 12 ? 2 : 1;
    const xOf = (min) => GX + ((min - h0 * 60) / ((h1 - h0) * 60)) * GW;
    const axis = () => {
      for (let hr = h0; hr <= h1; hr += step) doc.text(`${String(hr).padStart(2, '0')}:00`, xOf(hr * 60), y + 8, { size: 6.5, color: FAINT, align: hr === h0 ? 'left' : hr === h1 ? 'right' : 'center' });
      y += 13;
    };
    ensure(13 + 26 * Math.min(3, rows.length)); axis();
    for (const { d, timed, loose } of rows) {
      const RH = 22 + (loose.length ? 11 : 0);
      if (ensure(RH + 4)) axis();
      doc.fill('#f9fafb').rect(GX, y, GW, 22);
      doc.stroke(LINE).lineWidth(0.5);
      for (let hr = h0; hr <= h1; hr += step) doc.line(xOf(hr * 60), y, xOf(hr * 60), y + 22);
      doc.fill(d.color).circle(M + 4, y + 8, 3.5);
      doc.text(doc.fit(t('dayN', { n: d.index + 1 }), LW - 16, 8.5, true), M + 12, y + 11, { size: 8.5, bold: true, color: INK });
      if (d.label) doc.text(doc.fit(d.label, LW - 16, 7), M + 12, y + 20, { size: 7, color: MUTED });
      timed.forEach((s, k) => {
        const x1 = xOf(s.a), bw = Math.max(3, Math.min(xOf(s.e), GX + GW) - x1);
        doc.fill('#ffffff').roundRect(x1 - 0.6, y + 2.4, bw + 1.2, 17.2, 3.4);
        doc.fill(d.color).roundRect(x1, y + 3, bw, 16, 3);
        // The name goes inside the bar when it fits, else beside it up to the next bar.
        const full = `${s.i + 1} ${s.name}`, room = (timed[k + 1] ? xOf(timed[k + 1].a) : GX + GW) - (x1 + bw) - 8;
        if (doc.measure(full, 7, true) <= bw - 6) doc.text(full, x1 + 3, y + 13.5, { size: 7, bold: true, color: '#ffffff' });
        else {
          if (bw > 12) doc.text(String(s.i + 1), x1 + bw / 2, y + 13.5, { size: 7, bold: true, color: '#ffffff', align: 'center' });
          const label = room > 20 ? doc.fit(s.name, room, 7, true) : '';
          if (label) doc.text(label, x1 + bw + 4, y + 13.5, { size: 7, bold: true, color: INK });
        }
      });
      if (!timed.length && !loose.length) doc.text(t('nothingPlanned'), GX + 6, y + 14, { size: 7.5, color: FAINT });
      if (loose.length) doc.text(doc.fit(`${t('noTime')}: ${loose.join(' · ')}`, GW, 7), GX, y + 30, { size: 7, color: FAINT });
      y += RH + 4;
    }
    y += 14;
  }

  // ---- itinerary
  if (sections.has('itinerary')) {
    heading(t('itinerary'), `${t.n('nDays', data.days.length)} · ${t.n('nStops', stops)}`, sections.has('map') ? 150 : 60);
    if (!data.days.length) { doc.text(t('noDays'), M, y, { size: 10, color: MUTED }); y += 18; }
    const MINI_W = 150, MINI_H = 112;
    for (const d of data.days) {
      // A per-day detail map beside the stops — the overview is too coarse for multi-city trips.
      const mini = sections.has('map') && d.stops.some((s) => validCoord(s.lat, s.lng))
        ? buildMap({ days: [d], unscheduled: [] }, MINI_W, MINI_H, { minSpan: 0.0006, pad: 16, labels: false, gridLabels: false, view: fromPreview(views[`d${d.id}`], MINI_W, MINI_H) })
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
        const meta = [s.category, s.track ? trackLine(s.track, data.locale) : '', s.address].filter(Boolean).join(' · ');
        const notes = s.notes ? noteLines(doc, s.notes, CW - 60, 8.5, 12) : [];
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
        for (const l of notes) { if (l.bullet) doc.text(l.bullet, M + 56 + l.bx, y, { size: 8.5, color: FAINT }); doc.text(l.text, M + 56 + l.x, y, { size: 8.5, bold: l.bold, color: l.bold ? MUTED : FAINT }); y += 11; }
        y += 2;
      });
      for (const note of d.notes) {
        // Each note gets a bullet; Markdown inside it (lists, tables, headings) hangs under it.
        const lines = noteLines(doc, note, CW - 70, 8.5, 24);
        if (!lines.length) continue;
        ensure(Math.min(lines.length, 4) * 11 + 4);
        y += 2;
        if (!lines[0].bullet || lines[0].bx > 0) doc.text('•', M + 56, y, { size: 8.5, color: MUTED });
        for (const l of lines) {
          ensure(11);
          const x = M + 66;
          if (l.bullet) doc.text(l.bullet, x + l.bx, y, { size: 8.5, color: MUTED });
          doc.text(l.text, x + l.x, y, { size: 8.5, bold: l.bold, color: l.bold ? INK : MUTED });
          y += 11;
        }
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

  // ---- tours: each track with its own map, figures and elevation profile.
  if (sections.has('tours') && data.tours.length) {
    heading(t('tours'), t.n('nTours', data.tours.length), 150);
    const MW = 200, MH = 128, RX = M + MW + 16, RW = W - MW - 16;
    const detailed = opts.tourDetail === 'full';
    for (const tour of data.tours) {
      const tr = tour.track;
      ensure(detailed ? 300 : MH + 40);
      y += 4;
      // Title row: name, then when it is planned.
      const { when, figs } = tourInfo(data, tour, detailed);
      const ww = doc.measure(when, 9) + 10;
      doc.fill(tour.color).circle(M + 4, y - 3.5, 4);
      doc.text(doc.fit(tour.name, W - 14 - ww, 11.5, true), M + 14, y, { size: 11.5, bold: true, color: INK });
      doc.text(when, M + W, y, { size: 9, color: MUTED, align: 'right' });
      y += 10;
      const figure = ([label, value], fx, fy, fw) => {
        doc.text(doc.fit(upper(label), fw - 6, 6.5, true), fx, fy + 8, { size: 6.5, bold: true, color: MUTED });
        doc.text(doc.fit(value, fw - 6, 11, true), fx, fy + 22, { size: 11, bold: true, color: INK });
      };

      if (detailed) {
        // Detailed: a full-width map naming the positions along the route, all figures in a row, a large
        // profile with a height and distance grid, and the tour's notes in full.
        const DH = 230, step = niceStep(tr.km, 10);
        const map = tourMap(data, tour, W, DH, { pad: 34, labels: true, view: fromPreview(views[`t${tour.key}`], W, DH) });
        drawMap(doc, map, M, y);
        y += DH + 8;
        const fw = W / figs.length;
        figs.forEach((f, i) => figure(f, M + i * fw, y, fw));
        y += 34;
        if (tr.profile) {
          ensure(120);
          drawProfile(doc, tr, tour.color, M, y, W, 96, { locale: data.locale, grid: true, step });
          y += 96 + 16;
        }
        if (tour.positions.length) {
          for (const l of doc.wrap(`${t('alongRoute')}: ${tour.positions.map((q) => q.name).join('  ·  ')}`, W, 9)) { ensure(12); doc.text(l, M, y, { size: 9, color: INK }); y += 12; }
          y += 4;
        }
        for (const l of tour.notes ? noteLines(doc, tour.notes, W, 9) : []) { ensure(12); if (l.bullet) doc.text(l.bullet, M + l.bx, y, { size: 9, color: MUTED }); doc.text(l.text, M + l.x, y, { size: 9, bold: l.bold, color: l.bold ? INK : MUTED }); y += 12; }
        y += 2;
      } else {
        const top = y;
        drawMap(doc, tourMap(data, tour, MW, MH, { view: fromPreview(views[`t${tour.key}`], MW, MH) }), M, top);
        // Figures, three to a row.
        const fw = RW / 3;
        figs.forEach((f, i) => figure(f, RX + (i % 3) * fw, top + Math.floor(i / 3) * 30, fw));
        const used = top + Math.ceil(figs.length / 3) * 30 + 6;
        // Elevation profile over distance, or the tour's notes when the track has no heights.
        if (tr.profile) drawProfile(doc, tr, tour.color, RX, used, RW, top + MH - used, { locale: data.locale });
        else if (tour.notes) {
          let ny = used + 8;
          for (const l of noteLines(doc, tour.notes, RW, 8.5, Math.max(1, Math.floor((top + MH - ny) / 11)))) { if (l.bullet) doc.text(l.bullet, RX + l.bx, ny, { size: 8.5, color: MUTED }); doc.text(l.text, RX + l.x, ny, { size: 8.5, bold: l.bold, color: MUTED }); ny += 11; }
        }
        y = top + MH + 10;
      }
      doc.stroke(LINE).lineWidth(0.5).line(M, y, M + W, y);
      y += 12;
    }
    y += 6;
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
  // At most 4 maps at a time: a long trip has dozens, and the tile servers are shared, free services.
  const bases = new Array(slots.length).fill(null);
  if (opts.basemap) {
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < slots.length; i = next++) {
        const s = slots[i];
        bases[i] = await Promise.resolve()
          .then(() => opts.basemap(s.map, { labelScale: s.small ? 0.8 : 1, scale: s.small ? 2.5 : 2, measure: (txt, size, bold) => doc.measure(txt, size, bold), reserved: s.reserved }))
          .catch(() => null);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, slots.length) }, worker));
  }
  slots.forEach((s, i) => {
    const b = bases[i];
    const ops = b ? capture(doc, () => paintBasemap(doc, b, s.ox, s.oy, s.map.w, s.map.h)) : s.grid;
    s.page[s.index] = ops.join('\n');
  });
  // Map credits: one line in the footer of each page that shows a map background,
  // instead of a label on every map (the licences ask for visible credit near the maps).
  doc.pages.forEach((page, i) => {
    const credits = [...new Set(slots.flatMap((s, j) => (s.page === page && bases[j] ? [bases[j].attribution] : [])))];
    if (!credits.length) return;
    doc.setPage(i);
    const text = credits.map((c) => (c.startsWith('©') ? c : `© ${c}`)).join(' · ');
    doc.text(doc.fit(text, W - 220, 6.5), M + W / 2, doc.height - 20, { size: 6.5, color: FAINT, align: 'center' });
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
    // Labels keep clear of route markers and the scale bar.
    const reserved = map.markers.map((m) => [m.x - 10, m.y - 10, m.x + 10, m.y + 10]);
    // Scale bar: the first corner free of route markers.
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
    (doc.mapSlots = doc.mapSlots || []).push({ map, ox, oy, small, grid, reserved, page: doc.ops, index: doc.ops.length });
    doc.ops.push('');
    doc.stroke('#94a3b8').lineWidth(1.2).dash(4, 3);
    for (const l of map.links || []) doc.polyline(l.points.map(([x, y]) => [ox + x, oy + y]));
    doc.dash(0);
    for (const r of map.routes) {
      doc.stroke('#ffffff').lineWidth(4.5).polyline(r.points.map(([x, y]) => [ox + x, oy + y]));
      doc.stroke(r.color).lineWidth(2).polyline(r.points.map(([x, y]) => [ox + x, oy + y]));
    }
    for (const tr of map.tracks || []) {
      const line = tr.points.map(([x, y]) => [ox + x, oy + y]);
      doc.stroke('#ffffff').lineWidth(4.2).polyline(line);
      doc.stroke(tr.color).lineWidth(2.2).polyline(line);
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
  // "2026-11-12 14-05": date and 24-hour time in the user's zone, sortable, no ':' (Windows rejects it).
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(data.timeZone ? { timeZone: data.timeZone } : {}) })
    .formatToParts(data.generatedAt || new Date()).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day} ${p.hour}-${p.minute}`;
  // Keep letters of every script; drop only what file systems reject.
  const clean = (v) => v.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().replace(/\s+/g, ' ');
  const safe = clean(data.title).slice(0, 80) || data.t('trip');
  return `${safe} - ${clean(data.t('tripReport'))} ${date}.pdf`;
}

module.exports = { loadTrip, buildMap, renderPdf, costSummary, tourInfo, tourMap, fileName, SECTIONS, PREVIEW };
