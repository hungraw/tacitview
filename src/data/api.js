import { cachedJson, peek } from './cache.js';
import { detailPath } from './paths.js';

const API_BASE = '/api';
// name -> [path, client cache TTL ms]. Views (/views/*) are compact server-side projections (server/views.cjs).
export const SOURCES = {
  bridge: ['/views/bridge-state', 15_000],
  relay: ['/confidential/relay', 10_000],
  proverBoard: ['/prover/board', 15_000],
  proofPoolRecent: ['/prover/pool/recent', 15_000],
  reflectionProof: ['/reflection/proof?network=mainnet', 30_000],
  proverHealth: ['/prover-health', 15_000],
  evmActivity: ['/views/evm-activity', 15_000],
  assetList: ['/views/asset-list', 60_000],
  ammPools: ['/views/amm-pools', 30_000],
  farms: ['/farm/program?network=mainnet', 60_000],
  confidential: ['/views/confidential', 20_000],
  evmPools: ['/views/evm-pools', 30_000],
  withdrawalCheck: ['/views/withdrawal-check', 60_000],
  envelopes: ['/views/envelopes', 15_000],
  btcBlocks: ['/views/btc-blocks', 30_000],
  tacitChain: ['/views/chain-recent', 15_000],
  ethAssets: ['/views/eth-assets', 60_000],
  relayOps: ['/views/relay-ops', 60_000],
  privacy: ['/views/privacy', 60_000],
  checks: ['/views/checks', 15_000],
  bridgeLag: ['/views/bridge-lag', 60_000],
  bridgeBurns: ['/views/bridge-burns', 30_000],
  measuredPrivacy: ['/views/measured-privacy', 300_000],
};

// One retry after a network failure, or after a 504: a view build that passed the server's 8s deadline carries on
// and is stored when it ends, so asking again shortly after usually gets it. Other HTTP errors are final answers.
async function fetchWithRetry(url, options) {
  const again = async () => {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return fetch(url, options);
  };
  let response;
  try { response = await fetch(url, options); } catch (error) {
    if (options.signal?.aborted) throw error;
    return again();
  }
  return response.status === 504 ? again() : response;
}

// early.js started this page's first requests while the app was still loading: use those answers once, if fresh.
function takeEarly(path) {
  const all = globalThis.__tacitEarly;
  const e = all?.[path];
  if (!e) return null;
  delete all[path];
  return Date.now() - e.at < 10_000 ? e.data : null;
}

async function requestJson(path, signal) {
  const early = takeEarly(path);
  if (early) { const data = await early; if (data) return data; } // failed or not OK: ask normally below
  const response = await fetchWithRetry(`${API_BASE}${path}`, { headers: { accept: 'application/json' }, cache: 'no-store', signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw Object.assign(new Error(body?.detail || `HTTP ${response.status}`), { status: response.status });
  }
  const type = response.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new Error(`Tacit API ${path}: expected JSON`);
  const data = await response.json();
  // When the server built this answer (a CDN or server cache may hand out an older one) and whether it was a
  // fallback: kept beside the data, so the footer shows the data's real age rather than the time of this request.
  // The age is measured on the server's clock (its Date header, plus Age when a CDN held it), so a visitor whose clock
  // is off still sees the right age.
  const at = Number(response.headers.get('x-tacit-saved-at'));
  const serverNow = Date.parse(response.headers.get('date') || '') + (Number(response.headers.get('age')) || 0) * 1000;
  const age = at > 0 && Number.isFinite(serverNow) ? Math.max(0, serverNow - at) : null;
  const dataAt = age != null ? Date.now() - age : at > 0 ? Math.min(at, Date.now()) : null;
  if (data && typeof data === 'object') meta.set(data, { dataAt, serverStale: response.headers.get('x-tacit-cache') === 'stale' });
  return data;
}
export const meta = new WeakMap();

export async function loadSource(name, { signal, force = false } = {}) {
  if (!Object.hasOwn(SOURCES, name)) throw new Error(`Unknown Tacit data source: ${name}`);
  const [path, ttlMs] = SOURCES[name];
  return cachedJson(name, () => requestJson(path, signal), { ttlMs: force ? 0 : ttlMs, staleMs: 5 * 60_000 });
}

// Server-side footprint (classification + Bitcoin, EVM, tacit address and XNS resolution).
export async function footprint(query, { signal } = {}) {
  const q = String(query || '').trim().slice(0, 512);
  return (await cachedJson(`footprint:${q}`, () => requestJson(`/views/footprint?q=${encodeURIComponent(q)}`, signal), { ttlMs: 30_000, staleMs: 0, persist: false })).data;
}

// Detail page data: /views/<view>?id=… (or ?q= for footprint), cached briefly per id.
export const peekSource = (name, maxAgeMs) => peek(name, maxAgeMs, true);
export const peekDetail = (view, id, maxAgeMs) => peek(`detail:${view}:${String(id || '').trim().slice(0, 512)}`, maxAgeMs, false);

export async function detail(view, id, { signal } = {}) {
  const value = String(id || '').trim().slice(0, 512);
  return (await cachedJson(`detail:${view}:${value}`, () => requestJson(detailPath(view, value), signal), { ttlMs: 30_000, staleMs: 0, persist: false })).data;
}
