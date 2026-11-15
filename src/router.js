// Hash routes.
//   live pages:   #/  #/bitcoin  #/ethereum  #/bridge  #/privacy  (#/bridge/verifier opens Bridge at the Verifier)
//   lists:        #/tacit-chain[/<before>]  #/blocks[/<from height>]  #/pool-events[/<to block>]  #/assets  #/traced
//   details:      #/tx/<txid>  #/eth/<hash>  #/block/<height>  #/chain/<height>  #/address/<addr|name>  #/asset/<id>  #/search/<q>
// Bitcoin mainnet addresses: bech32 / bech32m (bc1…) and base58 (1…, 3…). The server checks the checksum.
export const isBtcAddress = (s) => /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/i.test(String(s).trim());
export const LIVE = new Set(['bitcoin', 'ethereum', 'bridge', 'privacy']);
export const DETAIL = {
  tx: { view: 'btc-tx', valid: (s) => /^[0-9a-f]{64}$/i.test(s) },
  eth: { view: 'eth-tx', valid: (s) => /^0x[0-9a-f]{64}$/i.test(s) },
  block: { view: 'btc-block', valid: (s) => /^\d{1,7}$/.test(s) },
  chain: { view: 'chain-block', valid: (s) => /^\d{1,9}$/.test(s) },
  asset: { view: 'asset', valid: (s) => /^[0-9a-f]{64}$/i.test(s) },
  address: { view: 'footprint', valid: (s) => s.length > 0 && s.length <= 512 },
  search: { view: 'footprint', valid: (s) => s.length > 0 && s.length <= 512 },
};
export const LISTS = {
  'tacit-chain': { view: 'chain-list', valid: (s) => /^\d{1,9}$/.test(s) },
  blocks: { view: 'block-list', valid: (s) => /^\d{1,7}$/.test(s) },
  'pool-events': { view: 'pool-events', valid: (s) => /^\d{1,10}$/.test(s) },
  assets: { view: 'asset-list', valid: () => false }, // no paging: one page holds every asset
  traced: { view: 'traced', valid: () => false }, // every traced ConfidentialPool spend, one page
};

export function parseRoute(hash = location.hash) {
  const m = /^#\/([a-z-]+)(?:\/(.+))?$/.exec(hash);
  if (!m) return { kind: 'live', page: 'home' };
  const [, name, raw] = m;
  let id = null;
  try { id = raw == null ? null : decodeURIComponent(raw).trim(); } catch { return { kind: 'invalid', id: raw }; } // e.g. #/tx/%
  if (LIVE.has(name) && id == null) return { kind: 'live', page: name };
  // #/bridge/verifier: the Bridge page, scrolled to the Verifier card (a link to share).
  if (name === 'bridge' && id === 'verifier') return { kind: 'live', page: 'bridge', anchor: 'checks' };
  // #/check/<address or tx>: the Ethereum page with the withdrawal check made (src/sections/withdrawal-check.js).
  if (name === 'check' && id) return { kind: 'live', page: 'ethereum' };
  if (LISTS[name]) return id == null || LISTS[name].valid(id) ? { kind: 'list', name, view: LISTS[name].view, id: id || '' } : { kind: 'invalid', id };
  if (name === 'address' && id != null && isBtcAddress(id)) return { kind: 'detail', name, id, view: 'btc-address' };
  if (DETAIL[name] && id != null) return DETAIL[name].valid(id) ? { kind: 'detail', name, id, view: DETAIL[name].view } : { kind: 'invalid', id };
  return { kind: 'invalid', id: hash };
}

// Where a search should go: a dedicated page when the input has one, else the search page.
export function routeForQuery(q) {
  const s = String(q || '').trim();
  if (/^0x[0-9a-f]{64}$/i.test(s)) return `#/eth/${s.toLowerCase()}`;
  if (/^\d{1,7}$/.test(s)) return `#/block/${s}`;
  if (isBtcAddress(s)) return `#/address/${/^bc1/i.test(s) ? s.toLowerCase() : s}`;
  if (/^(tacit|tactt|tacrt)1[02-9ac-hj-np-z]{6,}$/i.test(s)) return `#/address/${s.toLowerCase()}`;
  if (/^0x[0-9a-f]{40}$/i.test(s) || /^[a-z0-9-]{1,64}@[a-z0-9-]{1,32}$/i.test(s) || /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i.test(s)) return `#/address/${encodeURIComponent(s.toLowerCase())}`;
  return `#/search/${encodeURIComponent(s)}`;
}
