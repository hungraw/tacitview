// A decoded Bitcoin block (its Tacit envelopes), shared by every server instance through the CDN.
// A block's contents never change for its hash, so the decoded summary is cached by the CDN for a year at
// /api/views/btc-block-decoded?id=<hash>. On Vercel an instance asks that URL first: a CDN hit is a few KB instead of
// a 1.6 MB raw block, and a new instance no longer re-downloads ~48 blocks (which ran past the 20 s function limit and
// left the Bitcoin card loading). Locally, and if that URL fails, the block is downloaded and decoded here.
const { cached } = require('./upstream.cjs');
const { esplora } = require('./bitcoin.cjs');
const { decodeBlock } = require('./btc-block.cjs');

const DAY = 24 * 3600_000;
const HOST = process.env.VERCEL_ENV === 'production' ? process.env.VERCEL_PROJECT_PRODUCTION_URL : null;
const HASH = /^[0-9a-f]{64}$/;

// Download and decode here (the CDN route's own build, and the fallback).
const decodeHere = async (hash, hostIndex = 0) => decodeBlock(await esplora(`/block/${hash}/raw`, 'raw', hostIndex));

async function viaCdn(hash) {
  const r = await fetch(`https://${HOST}/api/views/btc-block-decoded?id=${hash}`, { signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`decoded block route answered ${r.status}`);
  const d = await r.json();
  if (d?.hash !== hash || !Array.isArray(d.envelopes)) throw new Error('decoded block route sent another block');
  return { hash: d.hash, txCount: d.txCount, envelopes: d.envelopes };
}

// Same cache key as before, so callers keep sharing one copy per instance.
function decodedBlock(hash, hostIndex = 0) {
  return cached(`btcblock:${hash}`, async () => {
    if (HOST && HASH.test(hash)) { try { return await viaCdn(hash); } catch { /* decode here instead */ } }
    return decodeHere(hash, hostIndex);
  }, { ttlMs: DAY, staleMs: DAY });
}

// The CDN route's build: decode here (never through the CDN, which would call itself).
async function decodedBlockView(id) {
  const hash = String(id || '').toLowerCase();
  if (!HASH.test(hash)) { const e = new Error('Not a block hash'); e.status = 404; throw e; }
  const d = await cached(`btcblock:${hash}`, () => decodeHere(hash), { ttlMs: DAY, staleMs: DAY });
  if (d.data.hash !== hash) { const e = new Error('Block not found'); e.status = 404; throw e; }
  return { view: 'btc-block-decoded', ...d.data, cacheTtl: 365 * 24 * 3600 };
}

module.exports = { decodedBlock, decodedBlockView };
