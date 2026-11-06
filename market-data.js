// The ONLY module that touches data. It reads Neon through the Data API; to integrate elsewhere, swap api() and
// load(). getData's and getMarkets' arguments and return shapes stay the same.
import { getToken } from './auth.js';
const API_URL = 'https://ep-plain-king-bdcfq2ot.apirest.c-8.us-east-2.aws.neon.tech/market_data/rest/v1';
const BOROUGH_ORDER = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx'];
const ASSET_ORDER = ['office', 'retail', 'industrial', 'multifamily']; // hotels excluded this pass
// Office: building class. Multifamily: star rating. Retail, industrial: property type (no star data).
const BREAKDOWN = {
  office: ['class a', 'class b', 'class c'],
  multifamily: ['4 & 5 star', '3 star', '1 & 2 star'],
  retail: ['general retail', 'neighborhood center', 'mall'],
  industrial: ['logistics', 'flex', 'specialized'],
};
// Multi-select pairs CoStar reports directly; any other combination is built by mergeRows.
const COMBO = { 'class a+class b': 'class a & b', 'class b+class c': 'class b & c' };
const DERIVED = { vacancy_rate: 'vacant_sf', availability_rate: 'available_sf' };
const PER_UNIT = new Set(['asking_rent_unit', 'market_sale_price_per_unit']);
function mergeRows(rows, metrics) {
  if (rows.some(r => !r)) return null;
  const out = { ...rows[0], note: null };
  for (const k of Object.keys(metrics)) {
    const u = metrics[k].unit;
    if (DERIVED[k]) continue;
    if (u === 'pct' || u === 'usd_psf' || PER_UNIT.has(k)) { out[k] = null; continue; }
    out[k] = rows.some(r => r[k] == null) ? null : rows.reduce((s, r) => s + r[k], 0);
  }
  for (const [k, num] of Object.entries(DERIVED)) out[k] = out[num] != null && out.inventory_sf ? out[num] / out.inventory_sf * 100 : null;
  return out;
}
async function api(path, retried = false) {
  const token = await getToken({ force: retried });
  const res = await fetch(API_URL + path, { headers: { Authorization: 'Bearer ' + token, 'Accept-Profile': 'dash_api' } });
  if (res.status === 401 && !retried) return api(path, true);
  if (!res.ok) throw new Error('Data API ' + res.status);
  return res.json();
}
let cache = null;
const rowCache = new Map();
async function loadAll() {
  let [meta, metrics, availability, cmMetrics, cmLatest, ustAvg] = await Promise.all(
    ['meta', 'metrics', 'availability', 'cm_metrics', 'cm_latest', 'ust_10y_quarter_avg'].map(v => api('/' + v)));
  // The views return nothing unless the signed-in user's verified email is on the approved list (schema/dash_api.sql).
  if (!meta.length) {
    await getToken({ force: true, message: 'This account is not on the approved list. Ask Alex for access, or sign in with an approved email.' });
    return loadAll();
  }
  const fx = {
    meta: meta[0], boroughs: BOROUGH_ORDER, availability: {}, boroughOf: {}, segsByAsset: {},
    metrics: Object.fromEntries(metrics.map(({ metric_id, ...m }) => [metric_id, m])),
    capital_markets: {
      // Null series_id means manual or derived: drop it so CM_DEFAULT's description stands.
      metrics: Object.fromEntries(cmMetrics.map(({ key, series_id, sort, ...m }) => [key, series_id ? { ...m, series_id } : m])),
      latest: Object.fromEntries(cmLatest.map(({ key, ...m }) => [key, m])),
      ust_10y_quarter_avg: Object.fromEntries(ustAvg.map(r => [r.period, r.value])),
    },
  };
  for (const a of availability) {
    (fx.availability[a.submarket] ??= {})[a.asset_type] = a.segments;
    fx.boroughOf[a.submarket] = a.borough;
    const set = (fx.segsByAsset[a.asset_type] ??= new Set());
    for (const seg of a.segments) set.add(seg);
  }
  return fx;
}
function load() {
  if (!cache) cache = loadAll().catch(e => { cache = null; throw e; });
  return cache;
}
// One submarket and asset type at a time, so a phone never pulls the whole table.
function loadRows(submarket, asset_type) {
  const key = submarket + '|' + asset_type;
  if (!rowCache.has(key)) {
    const q = '/quarterly?submarket=eq.' + encodeURIComponent(submarket) + '&asset_type=eq.' + encodeURIComponent(asset_type);
    rowCache.set(key, api(q).catch(e => { rowCache.delete(key); throw e; }));
  }
  return rowCache.get(key);
}
const qi = p => (+p.slice(0, 4)) * 4 + (+p.slice(5)) - 1;
const ql = i => `${Math.floor(i / 4)}Q${(i % 4) + 1}`;
const fp = p => p.slice(0, 4) + ' ' + p.slice(4);

function resolveWindow(win, asIdx, first) {
  const w = win || {};
  const type = ['t12', 'cy', 'ytd', 'custom'].includes(w.type) ? w.type : 't12';
  const asYear = Math.floor(asIdx / 4);
  const years = [];
  for (let y = Math.floor(first / 4); y * 4 + 3 <= asIdx; y++) years.push(y);
  let from, to, year = null, label, phrase, priorPhrase;
  if (type === 't12') {
    from = asIdx - 3; to = asIdx;
    label = `Trailing 12 months to ${fp(ql(asIdx))}`;
    phrase = `over the trailing 12 months to ${fp(ql(asIdx))}`;
    priorPhrase = `over the trailing 12 months to ${fp(ql(asIdx - 4))}`;
  } else if (type === 'ytd') {
    from = asYear * 4; to = asIdx;
    const span = (y) => to === from ? `${y} Q1` : `${y} Q1–Q${(to % 4) + 1}`;
    label = `Year to date, ${span(asYear)}`;
    phrase = `in ${span(asYear)}`; priorPhrase = `in ${span(asYear - 1)}`;
  } else if (type === 'cy') {
    year = years.includes(+w.year) ? +w.year : years[years.length - 1];
    if (year == null) year = asYear - 1;
    from = year * 4; to = year * 4 + 3;
    label = `Calendar year ${year}`;
    phrase = `in ${year}`; priorPhrase = `in ${year - 1}`;
  } else {
    from = w.from ? qi(w.from) : asIdx - 7; to = w.to ? qi(w.to) : asIdx;
    from = Math.max(first, Math.min(from, asIdx)); to = Math.max(first, Math.min(to, asIdx));
    if (from > to) [from, to] = [to, from];
    label = from === to ? fp(ql(from)) : `${fp(ql(from))} to ${fp(ql(to))}`;
    phrase = from === to ? `in ${fp(ql(from))}` : `from ${fp(ql(from))} to ${fp(ql(to))}`;
    priorPhrase = from === to ? `in ${fp(ql(from - 4))}` : `from ${fp(ql(from - 4))} to ${fp(ql(to - 4))}`;
  }
  return { type, year, years, from: ql(from), to: ql(to), fromIdx: from, toIdx: to, label, phrase, priorPhrase };
}

// Capital markets. Only getMarkets reads fx.capital_markets. Defaults describe the seven metrics when the
// fixture block is absent, so the tab can say what is missing instead of failing.
const CM_DEFAULT = [
  { key: 'treasury_10y', label: '10-yr Treasury', unit: 'pct', cadence: 'daily', source: 'U.S. Treasury', series_id: 'DGS10', def: 'Market yield on the 10-year Treasury note, constant maturity.' },
  { key: 'sofr_30d_avg', label: '30-day avg SOFR', unit: 'pct', cadence: 'daily', source: 'Federal Reserve Bank of New York', series_id: 'SOFR30DAYAVG', def: 'Compounded average of the Secured Overnight Financing Rate over 30 calendar days.' },
  { key: 'curve_10y2y', label: '10Y–2Y spread', unit: 'bps', cadence: 'daily', source: 'U.S. Treasury', series_id: 'T10Y2Y', def: '10-year less 2-year Treasury yield, same date. Back-filled as DGS10 − DGS2 when T10Y2Y lags.' },
  { key: 'cap_spread_10y', label: 'Cap rate spread over 10-yr', unit: 'bps', cadence: 'quarterly', source: 'CoStar estimate, U.S. Treasury', series_id: 'market_cap_rate − DGS10 quarter avg', derived: true, def: 'CoStar market cap rate for the selection less the mean of the daily 10-year over the same quarter.', caveat: 'The one labeled exception to the no-averaging rule: the 10-year side is a quarterly mean. Follows the As of control and filters.' },
  { key: 'cmbs_delinq_office', label: 'CMBS delinquency, office', unit: 'pct', cadence: 'monthly', source: 'Trepp', series_id: 'TREPP_CMBS_DELINQ_OFFICE', def: 'Trepp monthly published CMBS delinquency rate for office loans, national.', caveat: 'Whether brokers may quote this to clients is unconfirmed.' },
  { key: 'nyc_cmbs_ss', label: 'NYC CMBS in special servicing', unit: 'count', cadence: 'monthly', source: 'Trepp', series_id: 'Trepp loan listing (AIPI)', def: 'Count of NYC loans with special-servicing status over all NYC loans in the listing, at the listing date.', caveat: 'How AIPI scopes NYC and matches loans to a borough is unconfirmed. Quoting to clients and license scope are open items.' },
  { key: 'bank_cre_delinq', label: 'Bank CRE delinquency', unit: 'pct', cadence: 'quarterly', source: 'Federal Reserve Board', series_id: 'DRCRELEXFACBS', def: 'Delinquency rate on commercial real estate loans excluding farmland, all banks.', caveat: 'The prior dashboard used DRSREACBN, which includes residential loans. This uses the CRE-only series.' },
];
const CADENCE_DAYS = { daily: 1, monthly: 31, quarterly: 92 };
function dateEnd(d) {
  if (/^\d{4}Q[1-4]$/.test(d)) { const y = +d.slice(0, 4), q = +d[5]; return new Date(Date.UTC(y, q * 3, 0)); }
  if (/^\d{4}-\d{2}$/.test(d)) { const [y, m] = d.split('-').map(Number); return new Date(Date.UTC(y, m, 0)); }
  return new Date(d + 'T00:00:00Z');
}
export async function getMarkets({ as_of, cap_rate, cap_rate_year_ago, today = new Date() } = {}) {
  const fx = await load();
  const cm = fx.capital_markets || null;
  const metaByKey = {};
  if (cm && cm.metrics) for (const [k, v] of Object.entries(cm.metrics)) metaByKey[k] = v;
  const defs = CM_DEFAULT.map(d => ({ ...d, ...(metaByKey[d.key] || {}), key: d.key, def: d.def, caveat: d.caveat, derived: d.derived }));
  const latest = (cm && cm.latest) || {};
  const qavg = (cm && cm.ust_10y_quarter_avg) || {};
  as_of = as_of || fx.meta.data_through;
  const ya = ql(qi(as_of) - 4);
  const items = defs.map(m => {
    let o;
    if (m.key === 'cap_spread_10y') {
      const t = qavg[as_of], ty = qavg[ya];
      o = {
        value: cap_rate != null && t != null ? (cap_rate - t) * 100 : null, date: as_of,
        prior_year_value: cap_rate_year_ago != null && ty != null ? (cap_rate_year_ago - ty) * 100 : null, prior_year_date: ya,
        missingReason: !cm ? 'not_loaded' : t == null ? 'no_treasury' : cap_rate == null ? 'no_cap_rate' : null,
      };
    } else {
      const l = latest[m.key];
      o = l ? { ...l, missingReason: l.value == null ? 'not_reported' : null } : { value: null, date: null, missingReason: 'not_loaded' };
    }
    let stale = false;
    if (o.date && !m.derived) {
      const lag = CADENCE_DAYS[m.cadence] || 1;
      const allow = m.cadence === 'daily' ? 4 : lag * 2; // daily: two business days, allowing a weekend
      stale = (today - dateEnd(o.date)) / 864e5 > allow + (m.cadence === 'daily' ? 0 : lag);
    }
    return { ...m, ...o, stale };
  });
  return { loaded: !!cm, asOf: as_of, yearAgo: ya, items };
}

export async function getData({ submarket, asset_type, segment = 'all', as_of, window } = {}) {
  const fx = await load();
  const avail = {};
  for (const [s, types] of Object.entries(fx.availability)) {
    const t = {};
    for (const a of ASSET_ORDER) if (types[a]) t[a] = types[a];
    if (Object.keys(t).length) avail[s] = t;
  }
  const submarkets = Object.keys(avail).sort();
  if (!avail[submarket]) submarket = submarkets.includes('Soho') ? 'Soho' : submarkets[0];
  const assetTypes = ASSET_ORDER.filter(a => avail[submarket][a]);
  if (!assetTypes.includes(asset_type)) asset_type = assetTypes[0];
  const segs = avail[submarket][asset_type];
  const order = BREAKDOWN[asset_type] || [];
  const parts = String(segment || 'all').split('+').filter(s => order.includes(s) && segs.includes(s))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  segment = parts.length ? parts.join('+') : 'all';
  const exact = parts.length > 1 && COMBO[segment] && segs.includes(COMBO[segment]) ? COMBO[segment] : null;
  const source = parts.length > 1 ? exact : segment;
  const combined = parts.length > 1 && !exact;
  const slices = (BREAKDOWN[asset_type] || []).filter(s => segs.includes(s));

  const first = qi(fx.meta.first_period), last = qi(fx.meta.data_through);
  const periods = [];
  for (let i = first; i <= last; i++) periods.push(ql(i));
  if (!as_of || !periods.includes(as_of)) as_of = fx.meta.data_through;
  const asIdx = qi(as_of);

  const byKey = new Map();
  for (const r of await loadRows(submarket, asset_type)) byKey.set(r.segment + '|' + r.period, r);
  const rowAt = (seg, i) => byKey.get(seg + '|' + ql(i)) || null;
  const rowSel = i => combined ? mergeRows(parts.map(p => rowAt(p, i)), fx.metrics) : rowAt(source, i);

  const w = resolveWindow(window, asIdx, first);
  const flowIds = Object.keys(fx.metrics).filter(k => fx.metrics[k].measure_type === 'flow' && !k.endsWith('_t12'));
  const sumRange = (from, to, m) => {
    if (from < first) return null;
    let s = 0;
    for (let i = from; i <= to; i++) { const r = rowSel(i); if (!r || r[m] == null) return null; s += r[m]; }
    return s;
  };
  const flowFor = (m, shift) => {
    if (w.type === 't12') { const r = rowSel(asIdx - shift); return r && r[m + '_t12'] != null ? r[m + '_t12'] : null; }
    return sumRange(w.fromIdx - shift, w.toIdx - shift, m);
  };
  const flows = {};
  for (const m of flowIds) flows[m] = { current: flowFor(m, 0), prior: flowFor(m, 4) };

  return {
    meta: fx.meta,
    metrics: fx.metrics,
    submarkets, assetTypes,
    boroughs: (fx.boroughs.length ? fx.boroughs : ['']).map(b => ({ name: b, submarkets: submarkets.filter(s => (fx.boroughOf[s] || '') === b) })).filter(g => g.submarkets.length),
    borough: fx.boroughOf[submarket] || null, segments: segs, slices,
    periods: periods.slice(0, asIdx - first + 1),
    allPeriods: periods,
    params: { submarket, asset_type, segment, as_of, window: { type: w.type, year: w.year, from: w.from, to: w.to } },
    window: w,
    selection: parts, combined, comboSource: exact,
    breakdownInData: order.some(s => fx.segsByAsset[asset_type] && fx.segsByAsset[asset_type].has(s)),
    yearAgo: ql(asIdx - 4),
    row: rowSel(asIdx),
    rowYearAgo: rowSel(asIdx - 4),
    flows,
    series: periods.slice(0, asIdx - first + 1).map(p => ({ period: p, row: rowSel(qi(p)) })),
    sliceRows: slices.map(s => ({ segment: s, row: rowAt(s, asIdx) })),
  };
}
