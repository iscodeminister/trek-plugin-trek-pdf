// Built plugin entry — runs in an isolated child process.
const { definePlugin } = require('trek-plugin-sdk');
const { loadTrip, buildMap, renderPdf, costSummary, fileName, SECTIONS } = require('./report');
const { renderBasemap, ATTRIBUTION } = require('./tiles');
const { encodePng } = require('./png');

const UI_MAP = [640, 380];
const dayMap = (d, w, h) => buildMap({ days: [d], unscheduled: [] }, w, h, { minSpan: 0.0006, pad: 48 });
// Instance setting (Admin → Plugins → Trek PDF): OpenStreetMap background on/off.
const basemapOn = (ctx) => ctx.config.basemap !== false && ctx.config.basemap !== 'false';

const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function readInput(req) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const tripId = Number(b.tripId ?? req.query.tripId);
  const locale = typeof b.locale === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(b.locale) ? b.locale : 'en';
  const currency = typeof b.currency === 'string' && /^[A-Za-z]{3}$/.test(b.currency) ? b.currency.toUpperCase() : undefined;
  let timeZone;
  try { if (typeof b.timeZone === 'string' && b.timeZone.length < 64) { new Intl.DateTimeFormat('en', { timeZone: b.timeZone }); timeZone = b.timeZone; } } catch { /* invalid zone → UTC */ }
  return { tripId, locale, currency, timeZone, body: b };
}

async function handle(fn) {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = e && e.status ? e.status : /RESOURCE_FORBIDDEN|not a member/i.test(msg) ? 403 : 500;
    return json(status, { error: msg });
  }
}

module.exports = definePlugin({
  async onLoad(ctx) {
    ctx.log.info('trek-pdf loaded');
  },
  routes: [
    {
      // Everything the tab needs for its live preview: stats, map geometry, cost totals.
      method: 'POST', path: '/summary', auth: true,
      handler: (req, ctx) => handle(async () => {
        const { tripId, locale, currency, timeZone } = readInput(req);
        if (!Number.isInteger(tripId) || tripId <= 0) return json(400, { error: 'tripId is required' });
        const data = await loadTrip(ctx, tripId, { locale, currency, timeZone });
        return json(200, {
          title: data.title,
          dateRange: data.dateRange,
          duration: data.duration,
          days: data.days.length,
          stops: data.days.reduce((s, d) => s + d.stops.length, 0),
          unscheduled: data.unscheduled.length,
          lodging: data.lodging.length,
          costsEnabled: data.costs !== null,
          costItems: data.costs ? data.costs.length : 0,
          costs: costSummary(data),
          map: buildMap(data, ...UI_MAP),
          // One zoomed map per day so the tab can drill in (the overview is coarse for multi-city trips).
          dayMaps: data.days.map((d) => dayMap(d, ...UI_MAP)),
          basemap: basemapOn(ctx),
        });
      }),
    },
    {
      // Render the PDF and store it in the trip's Files (the iframe sandbox cannot download).
      method: 'POST', path: '/report', auth: true,
      handler: (req, ctx) => handle(async () => {
        const { tripId, locale, currency, timeZone, body } = readInput(req);
        if (!Number.isInteger(tripId) || tripId <= 0) return json(400, { error: 'tripId is required' });
        const sections = Array.isArray(body.sections) ? body.sections.filter((s) => SECTIONS.includes(s)) : SECTIONS;
        if (!sections.length) return json(400, { error: 'Pick at least one section' });
        const paper = body.paper === 'letter' ? 'letter' : 'a4';

        const data = await loadTrip(ctx, tripId, { locale, currency, timeZone });
        const basemap = basemapOn(ctx) ? (m, scale) => renderBasemap(m.view, m.w, m.h, scale) : null;
        const pdf = (await renderPdf(data, { sections, paper, basemap })).toBuffer();
        const name = fileName(data);
        const file = await ctx.files.create(tripId, {
          name,
          content_base64: pdf.toString('base64'),
          mimetype: 'application/pdf',
          description: `Trip report (${sections.join(', ')})`,
        });
        ctx.log.info(`report for trip ${tripId}: ${pdf.length} bytes`);
        return json(200, { file: { id: file && file.id, name, size: pdf.length } });
      }),
    },
    {
      // The tab's map background as a PNG data URL (the frame's CSP blocks tile hosts,
      // data: URLs are allowed). view: -1 = whole trip, otherwise a day index.
      method: 'POST', path: '/basemap', auth: true,
      handler: (req, ctx) => handle(async () => {
        const { tripId, body } = readInput(req);
        if (!Number.isInteger(tripId) || tripId <= 0) return json(400, { error: 'tripId is required' });
        if (!basemapOn(ctx)) return json(200, { image: null });
        const data = await loadTrip(ctx, tripId);
        const view = Number.isInteger(body.view) ? body.view : -1;
        const model = view >= 0 && data.days[view] ? dayMap(data.days[view], ...UI_MAP) : buildMap(data, ...UI_MAP);
        if (model.empty) return json(200, { image: null });
        const scale = Math.min(2, Math.max(1, Number(body.scale) || 1));
        const raster = await renderBasemap(model.view, model.w, model.h, scale);
        if (!raster) return json(200, { image: null });
        return json(200, { image: 'data:image/png;base64,' + encodePng(raster).toString('base64'), attribution: ATTRIBUTION });
      }),
    },
  ],
});
