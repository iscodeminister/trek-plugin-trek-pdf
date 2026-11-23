'use strict';
// What each user framed and picked in the Report tab, kept in the plugin's own database
// (db:own) so it survives reloads and other devices: per trip the map views (overview,
// each day, each tour), and per user the tab's choices (map style, sections, paper…).
// Storage is best-effort: if it fails, the tab keeps working from memory.

const MIGRATION = `CREATE TABLE IF NOT EXISTS prefs (
  user_id INTEGER NOT NULL,
  trip_id INTEGER NOT NULL,          -- 0 = the user's choices for every trip
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, trip_id, key)
)`;

// Map views: 'all' (whole trip), 'd<dayId>', 't<tourKey>'. Keyed by ids, not positions,
// so adding or reordering days and tours never moves a saved view to the wrong map.
const VIEW_KEY = /^(all|d\d{1,12}|t[A-Za-z0-9_-]{1,24})$/;
const MAX_VIEWS = 400;
const finite = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const validView = (v) => Array.isArray(v) && v.length === 3 && finite(v[0], -Math.PI, Math.PI) && finite(v[1], -3.2, 3.2) && finite(v[2], 10, 2e7);

/** Only well-formed views under known keys; null = forget that view. */
function cleanViews(raw, { allowNull = false } = {}) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw).slice(0, MAX_VIEWS)) {
    if (!VIEW_KEY.test(k)) continue;
    if (v === null && allowNull) out[k] = null;
    else if (validView(v)) out[k] = [+v[0].toFixed(7), +v[1].toFixed(7), +v[2].toFixed(2)];
  }
  return out;
}

/** The tab's choices, each checked against what the tab can actually offer. */
function cleanPrefs(raw, { styles, sections }) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (styles.includes(raw.style)) out.style = raw.style;
  if (raw.tourDetail === 'full' || raw.tourDetail === 'compact') out.tourDetail = raw.tourDetail;
  if (raw.paper === 'a4' || raw.paper === 'letter') out.paper = raw.paper;
  if (Array.isArray(raw.sections)) out.sections = [...new Set(raw.sections.filter((s) => sections.includes(s)))];
  return out;
}

const migrated = new WeakSet();
async function ready(ctx) {
  if (migrated.has(ctx.db)) return;
  await ctx.db.migrate('001_prefs', MIGRATION);
  migrated.add(ctx.db);
}

/** { views, prefs } for this user and trip; null when storage isn't available. */
async function load(ctx, userId, tripId) {
  if (!Number.isInteger(userId)) return null;
  try {
    await ready(ctx);
    const rows = await ctx.db.query('SELECT trip_id, key, value FROM prefs WHERE user_id = ? AND trip_id IN (0, ?)', userId, tripId);
    const views = {}, prefs = {};
    for (const r of rows) {
      let v;
      try { v = JSON.parse(r.value); } catch { continue; }
      if (r.trip_id === 0) prefs[r.key] = v;
      else if (r.key.startsWith('view:')) views[r.key.slice(5)] = v;
    }
    return { views: cleanViews(views), prefs };
  } catch (e) {
    ctx.log && ctx.log.warn && ctx.log.warn(`prefs unavailable: ${e && e.message}`);
    return null;
  }
}

/** Upsert (or, for null views, delete) in one transaction. */
async function save(ctx, userId, tripId, { views = {}, prefs = {} }) {
  if (!Number.isInteger(userId)) return false;
  const now = Date.now(), ops = [];
  const put = (trip, key, value) => ops.push({ sql: 'INSERT INTO prefs (user_id, trip_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, trip_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', args: [userId, trip, key, JSON.stringify(value), now] });
  for (const [k, v] of Object.entries(views)) {
    if (v === null) ops.push({ sql: 'DELETE FROM prefs WHERE user_id = ? AND trip_id = ? AND key = ?', args: [userId, tripId, `view:${k}`] });
    else put(tripId, `view:${k}`, v);
  }
  for (const [k, v] of Object.entries(prefs)) put(0, k, v);
  if (!ops.length) return true;
  await ready(ctx);
  for (let i = 0; i < ops.length; i += 100) await ctx.db.tx(ops.slice(i, i + 100));
  return true;
}

// GDPR: a deleted user's rows go; an export returns them as stored.
async function deleteUser(ctx, userId) {
  await ready(ctx);
  await ctx.db.exec('DELETE FROM prefs WHERE user_id = ?', userId);
}
async function exportUser(ctx, userId) {
  await ready(ctx);
  return ctx.db.query('SELECT trip_id, key, value, updated_at FROM prefs WHERE user_id = ? ORDER BY trip_id, key', userId);
}

module.exports = { load, save, cleanViews, cleanPrefs, deleteUser, exportUser, VIEW_KEY };
