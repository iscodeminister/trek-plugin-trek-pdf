// Built plugin entry — runs in an isolated child process.
const { definePlugin } = require('trek-plugin-sdk');
const { loadTrip, buildMap, renderPdf, costSummary, fileName, SECTIONS } = require('./report');
const { renderBasemap, toSvg } = require('./basemap');
const { normalizeLang, intlLocale, pdfLang, uiBundle } = require('./i18n');

const UI_MAP = [640, 380];
const dayMap = (d, w, h) => buildMap({ days: [d], unscheduled: [] }, w, h, { minSpan: 0.0006, pad: 48 });
// Instance setting (Admin → Plugins → Trek PDF): OpenFreeMap background on/off.
const basemapOn = (ctx) => ctx.config.basemap !== false && ctx.config.basemap !== 'false';

const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * Body: { tripId, lang?, locale?, currency?, timeZone? }.
 * lang = TREK UI language (wording + map labels); locale = the user's date/number format.
 */
function readInput(req) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const tripId = Number(b.tripId ?? req.query.tripId);
  const lang = normalizeLang(typeof b.lang === 'string' ? b.lang : b.locale);
  // TREK's 'br' / 'gr' aren't BCP-47 (Breton / nothing): map them like the host does.
  const locale = typeof b.locale === 'string' && LOCALE_RE.test(b.locale) && !/^(br|gr)$/i.test(b.locale) ? b.locale : intlLocale(lang);
  const currency = typeof b.currency === 'string' && /^[A-Za-z]{3}$/.test(b.currency) ? b.currency.toUpperCase() : undefined;
  let timeZone;
  try { if (typeof b.timeZone === 'string' && b.timeZone.length < 64) { new Intl.DateTimeFormat('en', { timeZone: b.timeZone }); timeZone = b.timeZone; } } catch { /* invalid zone → UTC */ }
  return { tripId, lang, locale, currency, timeZone, body: b };
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

const needTrip = (tripId) => (!Number.isInteger(tripId) || tripId <= 0 ? json(400, { error: 'tripId is required' }) : null);

module.exports = definePlugin({
  async onLoad(ctx) {
    ctx.log.info('trek-pdf loaded');
  },
  routes: [
    {
      // Everything the tab needs for its live preview: its strings, stats, map geometry, cost totals.
      method: 'POST', path: '/summary', auth: true,
      handler: (req, ctx) => handle(async () => {
        const { tripId, lang, locale, currency, timeZone } = readInput(req);
        const bad = needTrip(tripId);
        if (bad) return bad;
        const data = await loadTrip(ctx, tripId, { lang, locale, currency, timeZone });
        return json(200, {
          // locale = the one the server formatted dates/money with, so the tab's numbers match.
          i18n: { ...uiBundle(lang), locale },
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
        const input = readInput(req);
        const bad = needTrip(input.tripId);
        if (bad) return bad;
        const { tripId, currency, timeZone, body } = input;
        const sections = Array.isArray(body.sections) ? body.sections.filter((s) => SECTIONS.includes(s)) : SECTIONS;
        if (!sections.length) return json(400, { error: 'Pick at least one section' });
        const paper = body.paper === 'letter' ? 'letter' : 'a4';

        // Arabic/Hebrew need right-to-left shaping the PDF renderer doesn't do → English PDF.
        const lang = pdfLang(input.lang);
        const locale = lang === input.lang ? input.locale : 'en-US';
        const data = await loadTrip(ctx, tripId, { lang, locale, currency, timeZone });
        const basemap = basemapOn(ctx) ? (m, o) => renderBasemap(m, { ...o, lang, pdf: true }) : null;
        const pdf = (await renderPdf(data, { sections, paper, basemap })).toBuffer();
        const name = fileName(data);
        const file = await ctx.files.create(tripId, {
          name,
          content_base64: pdf.toString('base64'),
          mimetype: 'application/pdf',
          description: `${data.t('tripReport')} (${sections.join(', ')})`,
        });
        ctx.log.info(`report for trip ${tripId}: ${pdf.length} bytes, ${lang}`);
        return json(200, { file: { id: file && file.id, name, size: pdf.length } });
      }),
    },
    {
      // The tab's map background as vector geometry (SVG path data). view: -1 = whole
      // trip, otherwise a day index. Map labels follow the UI language.
      method: 'POST', path: '/basemap', auth: true,
      handler: (req, ctx) => handle(async () => {
        const { tripId, lang, body } = readInput(req);
        const bad = needTrip(tripId);
        if (bad) return bad;
        if (!basemapOn(ctx)) return json(200, { basemap: null });
        const data = await loadTrip(ctx, tripId, { lang });
        const view = Number.isInteger(body.view) ? body.view : -1;
        const model = view >= 0 && data.days[view] ? dayMap(data.days[view], ...UI_MAP) : buildMap(data, ...UI_MAP);
        if (model.empty) return json(200, { basemap: null });
        const reserved = model.markers.map((m) => [m.x - 12, m.y - 12, m.x + 12, m.y + 12]);
        if (model.scale) reserved.push([UI_MAP[0] - model.scale.len - 24, UI_MAP[1] - 26, UI_MAP[0], UI_MAP[1]]);
        reserved.push([0, UI_MAP[1] - 16, 230, UI_MAP[1]]);
        const base = await renderBasemap(model, { lang, labelScale: 1.25, reserved });
        return json(200, { basemap: base ? toSvg(base) : null });
      }),
    },
  ],
});
