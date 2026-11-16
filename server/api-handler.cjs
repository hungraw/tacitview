// Same-origin /api proxy. Used by server/dev-server.cjs locally and api/[...path].js on Vercel.
// - Only allowlisted upstream routes (server/proxy-routes.cjs) and views (server/views.cjs).
// - GET (and HEAD) only.
// - Shared-cache headers so a CDN serves repeat requests: one upstream fetch per TTL for all visitors.

const { routeTtl } = require('./proxy-routes.cjs');
const { VIEWS, getView } = require('./views.cjs');
const { getUpstream } = require('./upstream.cjs');
const { iconHandler } = require('./asset-icon.cjs');
const { later } = require('./background.cjs');

const STALE_WHILE_REVALIDATE = 60;
// Query params the explorer uses. Others are dropped and the rest sorted, so random query strings
// can't bypass the caches and multiply upstream load.
const QUERY_PARAMS = new Set(['network', 'from', 'limit', 'block', 'id']);

function canonicalQuery(searchParams) {
  const kept = [...searchParams].filter(([key, value]) => QUERY_PARAMS.has(key) && value.length <= 80);
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = new URLSearchParams(kept).toString();
  return query ? `?${query}` : '';
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(value));
}

function cacheHeaders(ttl, stale, refreshing) {
  return {
    // Browsers revalidate quickly; shared caches (Vercel CDN) hold it for the route TTL.
    // A stale answer (refresh under way) is not kept by the CDN for a whole TTL.
    'cache-control': `public, max-age=5, s-maxage=${stale ? 1 : ttl}, stale-while-revalidate=${STALE_WHILE_REVALIDATE}`,
    // 'refreshing': the last build, served while a new one is made (normal); 'stale': a fallback after a failure.
    'x-tacit-cache': stale ? (refreshing ? 'refreshing' : 'stale') : 'fresh',
    'x-tacit-cache-ttl': String(ttl),
  };
}

// Per-visitor limits on lookups that can each start upstream work (detail pages, search; logos are a fixed set):
// 300 a minute overall, well above fast clicking plus hover prefetch, list polling and refills, and 60 a minute for
// the views that download raw blocks, scan logs or fan out over many calls. Per instance, in memory: the shared
// budgets in upstream.cjs bound the total, and a Vercel WAF rate rule on /api/views/* makes it hold across instances.
const WINDOW_MS = 60_000, VISITORS_MAX = 5_000;
const LIMITS = { any: 300, heavy: 60 };
// names is left out: every page with addresses asks for it, and each address's names are cached for an hour.
const HEAVY = new Set(['/views/block-list', '/views/btc-block', '/views/pool-events', '/views/footprint', '/views/btc-address', '/views/btc-address-txs', '/views/withdrawal-check', '/views/traced']);
const visitors = new Map();
// Visitors are counted by a salted hash of their IP, never the IP itself; the salt is random per instance and never
// stored, so the counts cannot be tied back to an address, and they are gone after a minute.
const SALT = require('node:crypto').randomBytes(16);
const visitorKey = (ip) => require('node:crypto').createHash('sha256').update(SALT).update(ip).digest('base64url').slice(0, 16);
function overLimit(req, bucket = 'any') {
  const ip = String(req.headers?.['x-real-ip'] || req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const key = `${bucket}:${visitorKey(ip)}`;
  const now = Date.now();
  let v = visitors.get(key);
  if (!v || now > v.reset) {
    if (visitors.size >= VISITORS_MAX) for (const [k, x] of visitors) if (now > x.reset || visitors.size >= VISITORS_MAX) visitors.delete(k);
    v = { count: 0, reset: now + WINDOW_MS };
    visitors.set(key, v);
  }
  return ++v.count > LIMITS[bucket] ? Math.ceil((v.reset - now) / 1000) : 0;
}
const tooMany = (res, wait) => json(res, 429, { error: 'Too many lookups', detail: 'Too many lookups from this address; try again in a minute.' }, { 'retry-after': String(wait), 'cache-control': 'no-store' });

// Name the failing source instead of blaming Tacit's API for everything.
function errorTitle(error, view) {
  if (error.status === 404) return 'Not found';
  if (error.status === 429) return 'Busy right now';
  if (error.status === 504) return 'Took too long';
  if (error.status === 503) return 'Could not check';
  const m = String(error.message || '');
  if (/^RPC |RPC method/.test(m)) return 'Ethereum RPC unavailable';
  if (/mempool|blockstream|emzy|bitaroo|Bitcoin block/.test(m)) return 'Bitcoin data unavailable';
  if (/^Upstream /.test(m) || !view) return 'Tacit API unavailable';
  return 'Data unavailable';
}

function apiHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/^\/api/, '') || '/';
  if (path === '/asset-icon') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' }, { allow: 'GET' });
    return iconHandler(req, res, url.searchParams.get('id'));
  }
  const view = Object.hasOwn(VIEWS, path) ? VIEWS[path] : null;
  const ttl = view ? view.ttl : routeTtl(path);
  if (ttl === null || ttl === undefined) return json(res, 404, { error: 'Unknown API route' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' }, { allow: 'GET' });
  // Lookups count against the visitor's limit, and so does a non-canonical query string (it misses the CDN).
  // btc-block-decoded is exempt: instances ask it for every block (all from Vercel's addresses) and it is CDN-cached.
  if ((view?.param && path !== '/views/btc-block-decoded') || (!view && url.search && url.search !== canonicalQuery(url.searchParams))) {
    const wait = overLimit(req) || (HEAVY.has(path) ? overLimit(req, 'heavy') : 0);
    if (wait) return tooMany(res, wait);
  }
  const work = view ? getView(path, view.param ? url.searchParams.get(view.param) : undefined) : getUpstream(path, canonicalQuery(url.searchParams), { ttlMs: ttl * 1000 });
  // The home page's Tacit chain card is showing: verify its newest blocks in the background (the list view caches
  // receipts and checks for 20), so tapping one opens at once. Cached for 15s, so this runs at most that often.
  if (path === '/views/chain-recent') later(Promise.all([getView('/views/chain-list', ''), getView('/views/chain-activity')]));
  work
    // x-tacit-saved-at: when this answer was built (older than now when served from cache), or when its oldest
    // fallback input was saved, so the page shows its real age.
    .then(({ data, stale, refreshing, savedAt }) => json(res, 200, data, { ...(data?.partial ? { 'cache-control': 'no-store' } : cacheHeaders(data?.gaps ? 15 : Number(data?.cacheTtl) > 0 ? data.cacheTtl : ttl, stale, refreshing)), ...(savedAt ? { 'x-tacit-saved-at': String(Math.min(savedAt, Number(data?.staleSince) || savedAt)) } : {}) })) // settled data declares a longer life
    // 504 is a build past its deadline: it carries on into the cache, and the page asks again.
    .catch((error) => json(res, [404, 429, 503, 504].includes(error.status) ? error.status : 502, { error: errorTitle(error, view), detail: error.message }, { 'cache-control': 'no-store' }));
}

module.exports = { apiHandler, canonicalQuery, overLimit };
