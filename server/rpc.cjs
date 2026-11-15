// Read-only JSON-RPC to fixed public EVM endpoints. The only non-GET upstream calls this app makes.
// Fixed endpoints, fixed method allowlist, 5s timeout, cached through upstream.cjs.

const { cached, spend, inLookup } = require('./upstream.cjs');
const TIMEOUT_MS = 5_000;

// Several independent public endpoints per chain, tried in order. publicnode first on Ethereum: it is the only
// free one tested that serves eth_getLogs over 10,000 blocks (1rpc: 50 blocks, drpc: refused).
const RPCS = {
  // Tenderly's public gateway last: an archive node that serves eth_getLogs far older than the others (100,000-block
  // ranges, measured 2026-11-15), for a pool index whose snapshot is more than ~10,000 blocks old.
  1: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://gateway.tenderly.co/public/mainnet'],
  // publicnode first: mainnet.base.org refuses eth_getLogs ("request limit reached"); publicnode serves 50,000-block
  // ranges (it returned 403 on 2026-11-09 and works since 2026-11-12, so the others stay as fallbacks).
  8453: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'],
  4663: ['https://rpc.mainnet.chain.robinhood.com'],
};
// Self-hosting with your own nodes: each variable replaces that chain's public endpoints entirely, so no third-party
// RPC sees what this server looks up (TACITVIEW_ETH_RPC also replaces the archive endpoint below).
const OWN = { 1: process.env.TACITVIEW_ETH_RPC, 8453: process.env.TACITVIEW_BASE_RPC, 4663: process.env.TACITVIEW_ROBINHOOD_RPC };
for (const [id, url] of Object.entries(OWN)) if (url) RPCS[id] = [url];
const LOOKUPS = new Set(['eth_getTransactionReceipt', 'eth_getTransactionByHash']); // null may only mean "pruned here"
const METHODS = new Set(['eth_call', 'eth_getTransactionReceipt', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_getTransactionByHash', 'eth_getBalance', 'eth_getTransactionCount']);

async function rpcOnce(url, chainId, method, params, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`RPC ${chainId} ${new URL(url).host} HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`RPC ${chainId} ${new URL(url).host} ${method}: ${body.error.message || 'error'}`);
  return body.result;
}

async function rpcRaw(chainId, method, params, { fetchImpl = fetch } = {}) {
  const urls = RPCS[chainId];
  if (!urls) throw new Error(`No RPC for chain ${chainId}`);
  if (!METHODS.has(method)) throw new Error(`RPC method ${method} not allowed`);
  const errors = [];
  let empty = false;
  for (const url of urls) {
    try {
      const result = await rpcOnce(url, chainId, method, params, fetchImpl);
      // publicnode answers null for older transactions (its transaction index is pruned), so a null receipt or
      // transaction is asked of the next endpoint before it means "no such transaction".
      if (result == null && LOOKUPS.has(method)) { empty = true; continue; }
      return result;
    } catch (error) { errors.push(error); }
  }
  if (empty) return null;
  // Every endpoint failed: name each one's failure, not only the last one's.
  throw errors.length === 1 ? errors[0] : new Error(errors.map((e) => e.message).join('; '));
}

// Archive reads (logs older than the first endpoints keep, ~10,000 blocks on Ethereum): straight to the archive
// endpoint, then the usual order if it fails.
const ARCHIVE = OWN[1] ? {} : { 1: 'https://gateway.tenderly.co/public/mainnet' };
async function rpcArchive(chainId, method, params, { fetchImpl = fetch } = {}) {
  if (!METHODS.has(method)) throw new Error(`RPC method ${method} not allowed`);
  if (ARCHIVE[chainId]) { try { return await rpcOnce(ARCHIVE[chainId], chainId, method, params, fetchImpl); } catch { /* fall through */ } }
  return rpcRaw(chainId, method, params, { fetchImpl });
}

// Calls made in the same moment on one chain go out as one JSON-RPC batch: one HTTPS request instead of one per
// call (a view's parallel eth_calls each paid their own connection setup, ~0.3-0.7s apiece cold). Each call still
// gets its own result or error. If the batch request itself fails, every call falls back to rpcRaw on its own, which
// also tries the other endpoints. eth_getLogs stays unbatched: large responses, and only one endpoint serves it.
const BATCH_MAX = 20;
const queues = new Map(); // chainId -> [{ method, params, resolve, reject }]
async function sendBatch(chainId, items, fetchImpl = fetch) {
  const url = RPCS[chainId][0];
  let answers;
  try {
    const response = await fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(items.map((it, i) => ({ jsonrpc: '2.0', id: i, method: it.method, params: it.params }))), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    answers = await response.json();
    if (!Array.isArray(answers)) throw new Error('not a batch reply');
  } catch {
    for (const it of items) rpcRaw(chainId, it.method, it.params, { fetchImpl }).then(it.resolve, it.reject);
    return;
  }
  const byId = new Map(answers.map((a) => [a.id, a]));
  items.forEach((it, i) => {
    const a = byId.get(i);
    if (!a) return rpcRaw(chainId, it.method, it.params, { fetchImpl }).then(it.resolve, it.reject);
    if (a.error) {
      const message = `RPC ${chainId} ${new URL(url).host} ${it.method}: ${a.error.message || 'error'}`;
      // A revert is the contract's answer (unregistered name and the like). Anything else (rate limit, missing
      // state) is the endpoint's problem: try the endpoints one by one, as an unbatched call would.
      if (/revert/i.test(String(a.error.message || '')) || a.error.code === 3) return it.reject(new Error(message));
      return rpcRaw(chainId, it.method, it.params, { fetchImpl }).then(it.resolve, it.reject);
    }
    // A null lookup from the first endpoint may be a pruned index: confirm with the others (rpcRaw skips the first's null).
    if (a.result == null && LOOKUPS.has(it.method) && RPCS[chainId].length > 1) return rpcRaw(chainId, it.method, it.params, { fetchImpl }).then(it.resolve, it.reject);
    it.resolve(a.result);
  });
}
function rpcBatched(chainId, method, params) {
  if (!RPCS[chainId]) return Promise.reject(new Error(`No RPC for chain ${chainId}`));
  if (!METHODS.has(method)) return Promise.reject(new Error(`RPC method ${method} not allowed`));
  // Visitor lookups (receipts on three chains, reverse names) share one call budget per instance besides the
  // per-visitor limit; the site's own cards are not counted against it.
  try { if (inLookup()) spend('RPC lookup', 600); if (method === 'eth_getLogs') spend(`eth_getLogs on chain ${chainId}`, 40); } catch (e) { return Promise.reject(e); }
  if (method === 'eth_getLogs') return rpcRaw(chainId, method, params);
  return new Promise((resolve, reject) => {
    let q = queues.get(chainId);
    if (!q) { q = []; queues.set(chainId, q); setTimeout(() => { queues.delete(chainId); for (let i = 0; i < q.length; i += BATCH_MAX) sendBatch(chainId, q.slice(i, i + BATCH_MAX)); }, 2); }
    q.push({ method, params, resolve, reject });
  });
}

// `store`: 'chain' for settled data every page view reuses (block timestamps); visitor lookups default to 'lookup'.
function rpc(chainId, method, params, { ttlMs = 30_000, store } = {}) {
  return cached(`rpc:${chainId}:${method}:${JSON.stringify(params)}`, () => rpcBatched(chainId, method, params), { ttlMs, store }).then((r) => r.data);
}

// --- Minimal ABI helpers (selectors computed once with Keccak-256, verified against transfer() = a9059cbb) ---
const word = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');
function encodeString(value) {
  const hex = Buffer.from(String(value), 'utf8').toString('hex');
  return word('20') + word(Buffer.byteLength(String(value)).toString(16)) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
}
function decodeString(result) {
  const h = String(result || '').replace(/^0x/, '');
  if (h.length < 128) return '';
  const offset = Number.parseInt(h.slice(0, 64), 16) * 2;
  const length = Number.parseInt(h.slice(offset, offset + 64), 16);
  return Buffer.from(h.slice(offset + 64, offset + 64 + length * 2), 'hex').toString('utf8');
}
const decodeAddress = (result) => {
  const h = String(result || '').replace(/^0x/, '');
  const addr = `0x${h.slice(-40)}`;
  return /^0x0{40}$/.test(addr) || h.length < 40 ? null : addr;
};

// XNS: immutable address book on Ethereum mainnet (github.com/Walodja1987/XNSv2). Names are "label@namespace".
const XNS = '0x6e797ba2d3103aF167918e71a7E01DE40D45f74b';
const SEL = { getAddress: 'bf40fac1', getName: '5fd4b08a' };

async function xnsAddress(name) {
  return decodeAddress(await rpc(1, 'eth_call', [{ to: XNS, data: `0x${SEL.getAddress}${encodeString(name)}` }, 'latest'], { ttlMs: 300_000 }));
}
async function xnsName(address) {
  return decodeString(await rpc(1, 'eth_call', [{ to: XNS, data: `0x${SEL.getName}${word(address)}` }, 'latest'], { ttlMs: 300_000 })) || null;
}

module.exports = { rpc, rpcRaw, rpcArchive, sendBatch, RPCS, XNS, xnsAddress, xnsName, encodeString, decodeString, decodeAddress };
