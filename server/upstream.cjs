// Upstream fetch with a bounded in-memory cache, in-flight dedupe and stale fallback.
// One instance per server process; the CDN cache (see api-handler.cjs) sits in front of it.

const UPSTREAM = 'https://api.tacit.finance';
const TIMEOUT_MS = 6_000; // with the per-view deadline (views.cjs) this keeps a build well inside maxDuration

class UpstreamError extends Error {
  constructor(message, status, options) { super(message, options); this.status = status; }
}

// After a 429 that route gets a rest: no new calls to it until the cool-down ends (Retry-After, else 20s).
// Limits differ per route (/confidential/index is far stricter), so other routes keep working. The key is the route
// without its id (/points/0xA and /points/0xB share one), since the upstream limits the route, not the id.
// Callers fall back to their stale cache in the meantime.
const coolUntil = new Map();
const routeKey = (path) => path.replace(/\/(0x)?[0-9a-fA-F]{20,}$|\/\d+$/, '');

// Global budgets per kind of upstream work, shared by every visitor of this instance: a sweep of ids spends the
// budget and then gets 429 (or the stale copy) instead of turning into load on Esplora, the RPCs or Tacit's API.
// Visitor lookups (a view with an id or query) count against their own copy of each budget, run inside
// asLookup(): a sweep of ids spends that copy and leaves the site's own cards (no id) their full allowance.
const { AsyncLocalStorage } = require('node:async_hooks');
const lane = new AsyncLocalStorage();
const asLookup = (fn) => lane.run('lookup', fn);
const inLookup = () => lane.getStore() === 'lookup';
const budgets = new Map();
function spend(kind, perMinute) {
  const now = Date.now();
  const key = `${kind}:${lane.getStore() || 'site'}`;
  let b = budgets.get(key);
  if (!b || now > b.reset) { b = { used: 0, reset: now + 60_000 }; budgets.set(key, b); }
  if (++b.used > perMinute) throw new UpstreamError(`Busy: the ${kind} budget for this minute is spent`, 429);
}

async function fetchJson(path, search = '', { fetchImpl = fetch } = {}) {
  const key = routeKey(path);
  if (Date.now() < (coolUntil.get(key) || 0)) throw new UpstreamError(`Upstream ${key} cooling down after rate limit`, 429);
  if (key === '/points') spend('points lookup', 60);
  const url = new URL(path, UPSTREAM);
  url.search = search;
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.status === 429) coolUntil.set(key, Date.now() + (Number(response.headers.get('retry-after')) || 20) * 1000);
  if (!response.ok) throw new UpstreamError(`Upstream ${path} HTTP ${response.status}`, response.status);
  if (!(response.headers.get('content-type') || '').includes('application/json')) throw new UpstreamError(`Upstream ${path} did not return JSON`);
  try { return await response.json(); }
  catch (cause) { throw new UpstreamError(`Upstream ${path} returned invalid JSON`, undefined, { cause }); }
}

// A bounded cache: in-flight dedupe, stale fallback, least recently used entries dropped first.
// Separate instances keep user-driven lookups from evicting the data every page view needs.
function createCache(maxEntries) {
  const entries = new Map(); // key -> { data, savedAt, ttlMs, staleMs }
  const pending = new Map();
  const remember = (key, entry) => {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  };
  // Returns { data, stale, refreshing, savedAt }: `refreshing` marks the stale-while-revalidate answer (a new build is
  // under way, the copy is within ttl + swr), as against a fallback after a failed load. `ttlMs` may be a function of the data (e.g. confirmed txs live longer).
  // `swrMs`: for that long after expiry, answer with the expired entry at once and refresh it in the background.
  // `deadlineMs`: past it the caller gets the stale copy (or a 504), while the build runs on and is still stored.
  return async function cached(key, loader, { ttlMs = 10_000, staleMs = 5 * 60_000, swrMs = 0, deadlineMs = 0 } = {}) {
  const hit = entries.get(key);
  const now = Date.now();
  if (hit) { entries.delete(key); entries.set(key, hit); } // a read keeps the entry recent
  if (hit && now - hit.savedAt < hit.ttlMs) return { data: hit.data, stale: false, savedAt: hit.savedAt };
  if (pending.has(key)) return hit && now - hit.savedAt < hit.ttlMs + swrMs ? { data: hit.data, stale: true, refreshing: true, savedAt: hit.savedAt } : pending.get(key);
  const request = (async () => {
    const work = Promise.resolve().then(loader).then((data) => {
      const savedAt = Date.now();
      remember(key, { data, savedAt, ttlMs: typeof ttlMs === 'function' ? ttlMs(data) : ttlMs, staleMs });
      return { data, stale: false, savedAt };
    });
    let timer;
    try {
      if (!deadlineMs) return await work;
      work.catch(() => {}); // a late failure after the deadline has no one waiting for it
      return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new UpstreamError('Took too long; try again shortly', 504)), deadlineMs); timer.unref?.(); })]); // a deadline never keeps the process alive
    } catch (error) {
      if (hit && Date.now() - hit.savedAt < hit.staleMs) return { data: hit.data, stale: true, savedAt: hit.savedAt };
      throw error;
    } finally { clearTimeout(timer); pending.delete(key); }
  })();
  pending.set(key, request);
  if (hit && now - hit.savedAt < hit.ttlMs + swrMs) { request.catch(() => {}); return { data: hit.data, stale: true, refreshing: true, savedAt: hit.savedAt }; }
  return request;
  };
}

// Three stores, so one kind of traffic cannot evict another:
// - chain: settled chain data every page view reuses (decoded blocks, headers, verify results, timestamps);
// - lookup: what visitors search or open (addresses, txs, names, points, receipts);
// - live: the page's own views and upstream routes.
// A caller may name the store; otherwise the key's prefix decides.
const stores = { chain: createCache(3_000), lookup: createCache(1_500), live: createCache(600) };
const CHAIN = /^(btcblock:|btc:block:|btc:hash:|chain:verify:|chain:pool-events:)/;
const LOOKUP = /^(btc:addr|btc:tx:|names:|\/points\/|rpc:)/;
const storeFor = (key) => (CHAIN.test(key) ? 'chain' : LOOKUP.test(key) ? 'lookup' : 'live');
// A view build runs inside traced(): every cached answer it uses that was a fallback (or a view that says it is
// stale) is noted, so the view can say it is stale and since when, even though the view itself was built just now.
const traceStore = new AsyncLocalStorage();
async function traced(fn) {
  const trace = { stale: false, oldest: null };
  const result = await traceStore.run(trace, fn);
  return { result, trace };
}
async function cached(key, loader, options = {}) {
  const out = await stores[options.store || storeFor(key)](key, loader, options);
  const trace = traceStore.getStore();
  const since = out.stale && !out.refreshing ? out.savedAt : out.data?.stale === true ? out.data.staleSince ?? out.savedAt : null;
  if (trace && since != null) { trace.stale = true; trace.oldest = Math.min(trace.oldest ?? since, since); }
  return out;
}

function getUpstream(path, search = '', options = {}) {
  return cached(`${path}${search}`, () => fetchJson(path, search, options), options);
}

// Run `fn` over `items` with at most `limit` in flight. Failures resolve to { error }.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      try { out[index] = await fn(items[index], index); } catch (error) { out[index] = { error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

module.exports = { UPSTREAM, UpstreamError, fetchJson, cached, createCache, getUpstream, mapLimit, spend, routeKey, asLookup, inLookup, traced };
