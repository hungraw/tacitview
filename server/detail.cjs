// Detail views: one object per Bitcoin tx, Ethereum tx, Bitcoin block and Tacit chain block.
// Everything comes from allowlisted Tacit routes, Esplora and public RPCs; nothing is inferred beyond what the data shows.

const { getUpstream, cached } = require('./upstream.cjs');
const { decodeTx } = require('./envelope.cjs');
const { decodeBlock } = require('./btc-block.cjs');
const { decodedBlock } = require('./decoded-block.cjs');
const { esplora, mempoolTip } = require('./bitcoin.cjs');
const { rpc } = require('./rpc.cjs');
const { CONTRACTS } = require('./footprint.cjs');
const { decodePoolLogs } = require('./pool-logs.cjs');
const { bridgeOnChain, CONFIRMATIONS, TOKENS } = require('./chain-state.cjs');
const { decodeSettle } = require('./settle-decode.cjs');
const { nullifierIndex, rememberBurn, burnFor } = require('./bridge-links.cjs');
const { mapLimit } = require('./upstream.cjs');
const { later } = require('./background.cjs');

const DAY = 24 * 3600_000;
const IMMUTABLE = { ttlMs: DAY, staleMs: DAY };
const CHAINS = { 1: 'Ethereum', 8453: 'Base', 4663: 'Robinhood' };
const EXPLORERS = { 1: 'https://etherscan.io', 8453: 'https://basescan.org', 4663: 'https://explorer.mainnet.chain.robinhood.com' };
const POOL = '0x000000000ed1eabd231be41d93b719056f7febfc';

// How long a CDN may keep a response (seconds; api-handler reads `cacheTtl`, falling back to the view's TTL).
// Settled data changes no more: an attested Bitcoin tx or block only shows a growing confirmation count, so 5 minutes;
// an Ethereum tx past finality, a Tacit chain block with a successor, or an older page of pool logs, a day.
const SETTLED_BTC = 300, FINAL = 86_400, ETH_FINALITY = 64;

class NotFound extends Error { constructor(message) { super(message); this.status = 404; } }

async function bridgeState() {
  const [chain, tip] = await Promise.all([bridgeOnChain().catch(() => null), mempoolTip().catch(() => null)]);
  if (chain) return { attested: chain.attestedHeight, relayTip: chain.relayTipHeight, confirmationsNeeded: CONFIRMATIONS, tip, source: 'contracts' };
  const status = await getUpstream('/reflection/status', '', { ttlMs: 10_000 }).then((r) => r.data).catch(() => null);
  // /reflection/status tipHeight is already the attestable height (relay tip − 24): add the 24 back
  // so stateOf's one subtraction lands on it.
  const need = Number(status?.confirmations) || CONFIRMATIONS;
  return { attested: Number(status?.attestedHeight) || null, relayTip: Number.isFinite(Number(status?.tipHeight)) && status?.tipHeight != null ? Number(status.tipHeight) + need : null, confirmationsNeeded: need, tip, source: 'tacit api' };
}

// eligible ("awaiting reflection"): the relay on Ethereum has seen the block 24 deep (attestable = relay tip − 24,
// see the bridge contract). Bitcoin confirmations alone are not enough: the relay may lag the Bitcoin tip.
const stateOf = (height, b) => {
  if (!height || !b.attested) return null;
  if (height <= b.attested) return 'attested';
  return b.relayTip && height <= b.relayTip - b.confirmationsNeeded ? 'eligible' : 'confirming';
};

// Heights and block numbers: plain decimal digits only (no 0x10, 1e3 or 12.0), so one block has one cache key.
function heightParam(id, what, min = 0) {
  const s = String(id ?? '');
  if (!/^\d{1,10}$/.test(s) || Number(s) < min) throw new NotFound(`Not a valid ${what}`);
  return Number(s);
}
const BTC_REORG_DEPTH = 6; // a block hash is kept for a day only once it is this deep

async function assetsById() {
  const { data } = await getUpstream('/assets', '?network=mainnet', { ttlMs: 60_000 });
  return new Map((data.assets || []).map((a) => [a.asset_id, a]));
}

// ---- Bitcoin transaction ----
async function btcTx(id) {
  const txid = String(id || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new NotFound('Not a Bitcoin txid');
  const sideP = Promise.all([bridgeState(), assetsById().catch(() => new Map())]); // independent of the tx: start now
  sideP.catch(() => {});
  // Straight from Bitcoin via Esplora (four operators); confirmed transactions never change.
  const tx = (await cached(`btc:tx:${txid}`, async () => {
    try { return await esplora(`/tx/${txid}`); } catch (e) { if (e.status === 404 || e.status === 400) throw new NotFound('Transaction not found'); throw e; }
  }, { ttlMs: (t) => (t?.status?.confirmed ? DAY : 30_000), staleMs: DAY })).data;
  const [bridge, assets] = await sideP;
  const envelope = decodeTx(tx);
  const height = tx.status?.block_height || null;
  const inputAddresses = new Set(tx.vin.map((v) => v.prevout?.scriptpubkey_address).filter(Boolean));
  const asset = envelope?.assetId ? assets.get(envelope.assetId) : null;
  const vsize = Math.ceil(tx.weight / 4);
  // A bridge burn: find the Ethereum mint that spends its nullifier (pool logs of the last ~31 h).
  let mint;
  if (envelope?.name === 'bridge burn' && envelope.nullifier) {
    rememberBurn(envelope.nullifier, { txid, height });
    const index = await nullifierIndex().catch(() => null);
    const hit = index?.map.get(envelope.nullifier);
    mint = hit ? { tx: hit.tx, block: hit.block } : { tx: null, searchedFrom: index?.fromBlock ?? null };
  }
  return {
    view: 'btc-tx', mint, sources: ['Esplora /tx/<txid>', 'attested height: ConfidentialPool + BitcoinLightRelay', '/assets?network=mainnet', 'Esplora tip'],
    cacheTtl: stateOf(height, bridge) === 'attested' ? SETTLED_BTC : undefined,
    txid, confirmed: Boolean(tx.status?.confirmed), height, blockHash: tx.status?.block_hash || null, time: tx.status?.block_time || null,
    confirmations: height && bridge.tip ? bridge.tip - height + 1 : 0,
    bridge: { ...bridge, state: stateOf(height, bridge) },
    fee: tx.fee, size: tx.size, weight: tx.weight, vsize, feeRate: tx.fee != null ? tx.fee / vsize : null,
    envelope: envelope ? { name: envelope.name, code: envelope.opcodeHex, payloadBytes: envelope.payloadBytes, outputs: envelope.outputs ?? null, assetId: envelope.assetId ?? null, layout: envelope.layout ?? null } : null,
    asset: asset ? { id: asset.asset_id, ticker: asset.ticker, verified: Boolean(asset.verified), decimals: asset.decimals } : envelope?.assetId ? { id: envelope.assetId, ticker: null, verified: false } : null,
    signerKey: envelope && tx.vin[0]?.witness?.[1] ? tx.vin[0].witness[1].slice(2, 66) : null,
    vin: tx.vin.map((v, i) => ({ n: i, txid: v.txid, vout: v.vout, address: v.prevout?.scriptpubkey_address || null, type: v.prevout?.scriptpubkey_type || null, value: v.prevout?.value ?? null, envelope: i === 0 && Boolean(envelope) })),
    vout: tx.vout.map((v, i) => ({
      n: i, address: v.scriptpubkey_address || null, type: v.scriptpubkey_type, value: v.value,
      // Output i carries note i for Tacit transfers (SPEC §3.1); the note's amount is hidden.
      note: Boolean(envelope?.outputs && i < envelope.outputs),
      reusesInput: Boolean(v.scriptpubkey_address && inputAddresses.has(v.scriptpubkey_address)),
    })),
  };
}

// ---- Tacit chain block anchored by an Ethereum tx (binary search by ethBlock) ----
// The Tacit chain as this site rebuilds it from Ethereum (tacit-chain.cjs, measured-privacy.cjs chainBlocks).
const chainBlocks = (opts) => require('./measured-privacy.cjs').chainBlocks(opts);
const recentChain = () => chainBlocks({ limit: 50 });
async function chainBlockAt(height) {
  return (await chainBlocks({ limit: 1, before: height + 1 })).blocks.find((b) => b.height === height) || null;
}
// Tacit's own hashes for the blocks around `before` (its API keeps its newest 200): the cross-check behind each block's
// "Matches Tacit" badge. A Map of height -> hash, empty when the API is unavailable.
async function tacitHashes(before = null) {
  const r = await getUpstream('/prover/blocks', `?${before ? `before=${before}&` : ''}limit=100`, { ttlMs: 30_000, staleMs: DAY }).catch(() => null);
  return new Map((r?.data?.blocks || []).map((b) => [b.height, String(b.hash).toLowerCase()]));
}
// Every block hash covers its parent's hash, so once a block matches Tacit's, every block before it matches too:
// the highest matching height is remembered (it only grows) and stands for the whole chain below it, however old.
let matchedThrough = -1;
async function tacitAgreement() {
  const [newest, ours] = await Promise.all([tacitHashes(null), chainBlocks({ limit: 200 })]);
  const hit = ours.blocks.find((b) => newest.get(b.height) === String(b.hash).toLowerCase()); // newest first
  if (hit) matchedThrough = Math.max(matchedThrough, hit.height);
  return { matchedThrough, newest };
}
function againstTacit(b, { matchedThrough: through, newest }) {
  if (b.height <= through) return { status: 'verified', reason: b.height === through ? "Same hash as Tacit's API" : `Same as Tacit's API: block ${through.toLocaleString('en-US')} matches, and each hash includes the one before` };
  const theirs = newest.get(b.height);
  if (theirs && theirs !== String(b.hash).toLowerCase()) return { status: 'mismatch', reason: `Tacit's API has ${theirs.slice(0, 12)}… for this height` };
  return { status: 'unverifiable', reason: "Tacit's API has not published this height yet" };
}

async function chainBlockForTx(txHash) {
  // The latest 50 Tacit chain blocks in one call. Older anchors are not searched: the API is rate-limited.
  const recent = await recentChain();
  return (recent.blocks || []).find((b) => b.tx.toLowerCase() === txHash) || null;
}


// ---- Ethereum (or Base / Robinhood) transaction ----
// A Wrap log carries the pool's asset id and a raw amount. The token is the one whose ERC-20 Transfer in the same
// receipt moves exactly that amount; its decimals are known only for the tokens in chain-state TOKENS (all 18, read
// with decimals()). Anything else stays in base units.
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TOKEN_BY_ADDRESS = new Map(Object.entries(TOKENS).map(([symbol, address]) => [address, symbol]));
function withWrapToken(events, receipt) {
  return events.map((e) => {
    if (e.type !== 'wrap') return e;
    const hit = (receipt.logs || []).find((l) => l.topics?.[0] === TRANSFER && TOKEN_BY_ADDRESS.has(String(l.address).toLowerCase()) && /^0x[0-9a-f]+$/i.test(l.data || '') && BigInt(l.data).toString() === e.amount);
    return hit ? { ...e, token: { symbol: TOKEN_BY_ADDRESS.get(String(hit.address).toLowerCase()), address: String(hit.address).toLowerCase(), decimals: 18 } } : e;
  });
}

// A withdrawal or fee is paid by an ERC-20 Transfer in the same receipt: to the recipient, or to the sender of the
// transaction for fees. Only tokens in chain-state TOKENS have known decimals (18); others stay in-system units.
function withPayouts(settlement, receipt) {
  if (!settlement) return null;
  const transfers = (receipt.logs || []).filter((l) => l.topics?.[0] === TRANSFER && TOKEN_BY_ADDRESS.has(String(l.address).toLowerCase()))
    .map((l) => ({ to: `0x${String(l.topics[2] || '').slice(26)}`.toLowerCase(), amount: BigInt(l.data || '0x0').toString(), symbol: TOKEN_BY_ADDRESS.get(String(l.address).toLowerCase()) }));
  const used = new Set();
  const paid = (to) => { const i = transfers.findIndex((t, k) => !used.has(k) && t.to === String(to).toLowerCase()); if (i < 0) return null; used.add(i); return { symbol: transfers[i].symbol, amount: transfers[i].amount, decimals: 18 }; };
  return {
    ...settlement,
    withdrawals: settlement.withdrawals.map((w) => ({ ...w, paid: paid(w.recipient) })),
    fees: settlement.fees.map((f) => ({ ...f, paid: paid(receipt.from) })),
  };
}

async function ethTx(id) {
  const hash = String(id || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new NotFound('Not an EVM transaction hash');
  // Started alongside the receipts (all independent of them); only used when the tx touches the pool.
  const chainBlockP = chainBlockForTx(hash).catch(() => undefined); // undefined: the search failed (null: not found)
  const headP = rpc(1, 'eth_blockNumber', [], { ttlMs: 10_000 }).then((h) => Number.parseInt(h, 16)).catch(() => null);
  // Ask every chain at once, but answer as soon as Ethereum has it: most hashes here are Ethereum transactions, and
  // Base and Robinhood answer more slowly.
  // A chain that fails is asked once more; if one still fails and no chain has the transaction, the answer is "could
  // not check", not "not found" (an RPC error must never read as a missing transaction).
  const receipt = (c) => rpc(Number(c), 'eth_getTransactionReceipt', [hash], { ttlMs: (x) => (x ? 300_000 : 10_000) }); // not mined yet: ask again soon
  const asks = Object.keys(CHAINS).map((c) => receipt(c).catch(() => new Promise((ok) => setTimeout(ok, 600)).then(() => receipt(c)))
    .then((r) => ({ chain: Number(c), r }), (error) => ({ chain: Number(c), r: null, error })));
  const eth = await asks[Object.keys(CHAINS).indexOf('1')];
  const all = eth?.r ? [eth] : await Promise.all(asks);
  const found = all.find((x) => x.r);
  if (!found) {
    const failed = all.filter((x) => x.error).map((x) => CHAINS[x.chain]);
    if (failed.length) { const e = new Error(`Could not check ${failed.join(' and ')}: the RPC did not answer. Try again in a moment.`); e.status = 503; throw e; }
    throw new NotFound('Transaction not found on Ethereum, Base or Robinhood');
  }
  const { chain, r } = found;
  const block = Number.parseInt(r.blockNumber, 16);
  const [blockInfo, chainBlockFound, ethHead] = await Promise.all([rpc(chain, 'eth_getBlockByNumber', [r.blockNumber, false], IMMUTABLE).catch(() => null), chainBlockP, headP]);
  const touched = [...new Set((r.logs || []).map((l) => CONTRACTS[String(l.address).toLowerCase()]).filter(Boolean))];
  const touchesPool = chain === 1 && (r.logs || []).some((l) => String(l.address).toLowerCase() === POOL);
  const events = touchesPool ? withWrapToken(decodePoolLogs(r), r) : [];
  // What the settle call published (its PublicValues), with each payout matched to the token Transfer that paid it.
  const input = touchesPool ? await rpc(chain, 'eth_getTransactionByHash', [hash], { ttlMs: 24 * 3600_000 }).then((t) => t?.input, () => null) : null;
  const settlement = input ? withPayouts(decodeSettle(input), r) : null;
  // The Bitcoin burn behind each minted nullifier, when this instance has seen that burn.
  if (settlement?.burnNullifiers?.length) settlement.burns = settlement.burnNullifiers.map((n) => ({ nullifier: n, burn: burnFor(n) }));
  const chainBlock = touchesPool ? chainBlockFound || null : null;
  // Final only when every part was read: a failed block read or anchor search is not kept for a day.
  const complete = blockInfo && (!touchesPool || chainBlockFound !== undefined);
  const gasPrice = r.effectiveGasPrice ? BigInt(r.effectiveGasPrice) : null;
  const head = chain === 1 ? ethHead : null;
  return {
    cacheTtl: complete && head && block < head - ETH_FINALITY ? FINAL : undefined,
    view: 'eth-tx', sources: ['eth_getTransactionReceipt (pool events decoded from logs)', 'eth_getBlockByNumber', 'Tacit chain rebuilt from Ethereum (this site)'],
    hash, chain, chainName: CHAINS[chain], explorer: `${EXPLORERS[chain]}/tx/${hash}`,
    status: r.status === '0x1' ? 'success' : 'reverted', block, time: blockInfo ? Number.parseInt(blockInfo.timestamp, 16) : null,
    from: r.from, fromName: CONTRACTS[String(r.from || '').toLowerCase()] || null, to: r.to, toName: CONTRACTS[String(r.to || '').toLowerCase()] || null, touched, logCount: (r.logs || []).length,
    gasUsed: Number.parseInt(r.gasUsed, 16), gasPriceWei: gasPrice?.toString() ?? null,
    feeWei: gasPrice ? (gasPrice * BigInt(r.gasUsed)).toString() : null,
    poolEvents: events, settlement,
    chainBlockSearched: touchesPool ? 'latest 50 Tacit chain blocks' : null,
    chainBlock: chainBlock ? { height: chainBlock.height, hash: chainBlock.hash, prev: chainBlock.prev, notes: chainBlock.notes, spent: chainBlock.spent, deposits: chainBlock.deposits } : null,
  };
}

// ---- Bitcoin block ----
async function btcBlock(id) {
  const height = heightParam(id, 'block height');
  const bridgeP = bridgeState(), assetsP = assetsById().catch(() => new Map()); // independent of the block: start now
  bridgeP.catch(() => {});
  const tip = await mempoolTip().catch(() => null);
  if (tip && height > tip + 2) throw new NotFound('Block not found');
  // A height's hash can change in a reorg: kept for a day only once the block is buried.
  const hash = await cached(`btc:hash:${height}`, async () => {
    try { return String(await esplora(`/block-height/${height}`, 'text')).trim(); } catch (e) { if (e.status === 404 || e.status === 400) throw new NotFound('Block not found'); throw e; }
  }, { ttlMs: tip && tip - height + 1 >= BTC_REORG_DEPTH ? DAY : 60_000, staleMs: DAY }).then((x) => x.data);
  const [info, decoded, bridge, assets] = await Promise.all([
    cached(`btc:block:${hash}`, () => esplora(`/block/${hash}`), IMMUTABLE).then((x) => x.data),
    decodedBlock(hash).then((x) => x.data),
    bridgeP, assetsP,
  ]);
  return {
    view: 'btc-block', sources: ['Esplora /block-height, /block/:hash, /block/:hash/raw (decoded here)', 'attested height: ConfidentialPool + BitcoinLightRelay'],
    cacheTtl: stateOf(height, bridge) === 'attested' ? SETTLED_BTC : undefined,
    height, hash, time: info.timestamp, txCount: info.tx_count, size: info.size, weight: info.weight, previous: info.previousblockhash,
    confirmations: bridge.tip ? bridge.tip - height + 1 : null, bridge: { ...bridge, state: stateOf(height, bridge) },
    envelopes: decoded.envelopes.map((e) => ({ ...e, ticker: e.assetId ? assets.get(e.assetId)?.ticker || null : null })),
  };
}

// ---- Tacit chain block ----
// Raw inputs for the in-browser check on a Tacit chain block page: the block as this site computed it and the
// anchoring transaction's receipt logs and calldata exactly as Ethereum returns them. The browser decodes and hashes
// them itself (src/verify-block.js), so this server's own decoding is not part of that check. Fetched on demand.
async function chainRaw(id) {
  const height = heightParam(id, 'Tacit chain height', 1);
  const b = await chainBlockAt(height);
  if (!b || b.height !== height) throw new NotFound('Tacit chain block not found');
  const [receipt, tx, head] = await Promise.all([
    rpc(1, 'eth_getTransactionReceipt', [b.tx], { ttlMs: (x) => (x ? 3600_000 : 10_000) }),
    rpc(1, 'eth_getTransactionByHash', [b.tx], { ttlMs: (x) => (x ? 3600_000 : 10_000) }),
    rpc(1, 'eth_blockNumber', [], { ttlMs: 10_000 }).then((h) => Number.parseInt(h, 16)).catch(() => null),
  ]);
  if (!receipt || !tx) throw new NotFound('Anchoring transaction not found on Ethereum');
  return {
    view: 'chain-raw', sources: ['Tacit chain rebuilt from Ethereum (this site)', 'eth_getTransactionReceipt', 'eth_getTransactionByHash'],
    published: { height: b.height, hash: b.hash, prev: b.prev, ethBlock: b.ethBlock, tx: b.tx },
    receipt: { blockNumber: receipt.blockNumber, transactionHash: receipt.transactionHash, logs: (receipt.logs || []).map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex })) },
    input: tx.input,
    cacheTtl: head && b.ethBlock < head - ETH_FINALITY ? FINAL : undefined, // inside the reorg window: the view's own 5 min
  };
}

async function chainBlock(id) {
  const height = heightParam(id, 'Tacit chain height', 1);
  const [b, recent, parent] = await Promise.all([chainBlockAt(height), recentChain().catch(() => null), height > 1 ? chainBlockAt(height - 1).catch(() => null) : null]);
  if (!b || b.height !== height) throw new NotFound('Tacit chain block not found');
  const parentLinked = parent && parent.height === height - 1 ? String(parent.hash).toLowerCase() === String(b.prev).toLowerCase() : null;
  const head = recent?.head;
  const [receipt, hashes] = await Promise.all([
    rpc(1, 'eth_getTransactionReceipt', [b.tx], { ttlMs: (x) => (x ? 3600_000 : 10_000) }).catch(() => null),
    tacitAgreement(),
  ]);
  const verification = againstTacit(b, hashes);
  const events = receipt ? decodePoolLogs(receipt) : null;
  return {
    view: 'chain-block', sources: ['Tacit chain rebuilt from Ethereum (this site)', '/prover/blocks (hash compared)', 'eth_getTransactionReceipt (pool events decoded from logs)'],
    height: b.height, hash: b.hash, prev: b.prev, ethBlock: b.ethBlock, tx: b.tx, notes: b.notes, spent: b.spent, deposits: b.deposits,
    head: head?.height ?? null, poolEvents: events, partial: !events, verification, parentLinked,
    cacheTtl: head?.height > b.height && verification.status !== 'unverifiable' ? FINAL : undefined,
  };
}

// ---- Lists ----
const PAGE = 20;

// Tacit chain, 20 blocks per page, newest first, each verified from its anchoring transaction's logs.
async function chainList(id) {
  const before = id ? heightParam(id, 'Tacit chain height', 1) + 1 : null;
  // An older page is kept for a day only when it starts where asked (an id past the head returns the newest page).
  const data = await chainBlocks({ limit: PAGE, before });
  const blocks = data.blocks || [];
  const agreement = await tacitAgreement();
  const checks = blocks.map((b) => againstTacit(b, agreement));
  return {
    view: 'chain-list', sources: ['Tacit chain rebuilt from Ethereum (this site)', '/prover/blocks (hashes compared)'],
    head: data.head?.height ?? null, from: blocks[0]?.height ?? null, oldest: data.oldest,
    blocks: blocks.map((b, i) => ({ height: b.height, hash: b.hash, prev: b.prev, ethBlock: b.ethBlock, tx: b.tx, notes: b.notes, spent: b.spent, deposits: b.deposits, verification: checks[i]?.status || 'unverifiable', verificationNote: checks[i]?.reason || null })),
    next: blocks.length === PAGE && blocks.at(-1).height > (data.oldest ?? 0) ? blocks.at(-1).height - 1 : null,
  };
}

// Bitcoin blocks, 20 per page from a height down, every Tacit envelope decoded from the raw block.
async function blockList(id) {
  const bridgeP = bridgeState(); // not needed until the end
  bridgeP.catch(() => {});
  const tip = await mempoolTip();
  const from = id ? Math.min(heightParam(id, 'block height'), tip) : tip;
  const heights = Array.from({ length: PAGE }, (_, i) => from - i).filter((h) => h >= 0);
  const pages = await Promise.all([esplora(`/blocks/${from}`), esplora(`/blocks/${from - 10}`)]);
  const list = pages.flat().filter((b) => heights.includes(b.height)).sort((a, b) => b.height - a.height);
  const done = new Array(list.length).fill(null);
  const assetsP = assetsById().catch(() => new Map());
  const work = mapLimit(list, 6, (b, i) => decodedBlock(b.id, i % 4)
    .then((r) => { done[i] = r; }, (error) => { done[i] = { error }; }));
  // Answer within 3s with what is decoded (partial); the rest keeps decoding into the cache, and the page asks again.
  later(work);
  await Promise.race([work, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  const [assets, bridge] = await Promise.all([assetsP, bridgeP]);
  return {
    view: 'block-list', sources: ['Esplora /blocks, /block/:hash/raw (decoded here)', 'attested height from the contracts'],
    tip, from, bridge,
    blocks: list.map((b, i) => ({
      height: b.height, hash: b.id, time: b.timestamp, txCount: b.tx_count, state: stateOf(b.height, bridge),
      envelopes: done[i]?.data ? done[i].data.envelopes.map((e) => ({ txid: e.txid, name: e.name || e.opcodeHex, ticker: e.assetId ? assets.get(e.assetId)?.ticker || null : null })) : null,
    })),
    next: from - PAGE >= 0 ? from - PAGE : null, partial: done.some((r) => !r?.data),
  };
}

const POOL_DEPLOY_BLOCK = 25_998_736;
// The free public RPCs serve eth_getLogs only about 10,000 blocks back (publicnode, measured 2026-11-12: served at
// 9,921, "Archive requests require a personal token" at 10,038; drpc and 1rpc refuse 2,000-block ranges). Older
// windows are answered without an upstream call, pointing to Etherscan.
const LOG_DEPTH = 9_500;
const POOL_LOGS_ETHERSCAN = 'https://etherscan.io/address/0x000000000Ed1eabD231Be41d93b719056F7febFC#events';
// ConfidentialPool events from the logs, newest first, in Ethereum block windows.
async function poolEvents(id) {
  const want = id ? heightParam(id, 'Ethereum block number') : null;
  const head = Number.parseInt(await rpc(1, 'eth_blockNumber', [], { ttlMs: 10_000 }), 16);
  // Fixed windows of 2,000 blocks ([k·2000, k·2000+1999]), so every id inside one window shares one eth_getLogs call.
  // The newest page runs from the start of the previous window to the head.
  const span = 2_000;
  if (want != null && want > head) throw new NotFound('Ethereum block not reached yet');
  // Nothing to read before the pool existed: answer without an upstream call (deploy block 25,998,736).
  if (want != null && want < POOL_DEPLOY_BLOCK) throw new NotFound(`The ConfidentialPool was deployed at Ethereum block ${POOL_DEPLOY_BLOCK.toLocaleString('en-US')}`);
  const windowStart = want != null ? Math.floor(want / span) * span : (Math.floor(head / span) - 1) * span;
  if (want != null && windowStart < head - LOG_DEPTH) throw new NotFound(`Pool logs older than about ${LOG_DEPTH.toLocaleString('en-US')} Ethereum blocks need an archive node, which the free public RPCs this explorer reads do not serve. Older events are on Etherscan: ${POOL_LOGS_ETHERSCAN}`);
  const fromBlock = Math.max(POOL_DEPLOY_BLOCK, windowStart);
  const to = want != null ? Math.min(windowStart + span - 1, head) : head;
  const logs = await rpc(1, 'eth_getLogs', [{ address: '0x000000000Ed1eabD231Be41d93b719056F7febFC', fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${to.toString(16)}` }], { ttlMs: to < head - ETH_FINALITY ? DAY : 15_000 });
  const events = decodePoolLogs({ logs }).map((e) => {
    const raw = logs.find((l) => Number.parseInt(l.logIndex, 16) === e.logIndex);
    // Only what the list shows: a count per event and the first nullifier (full arrays made the page ~58 KB).
    return { type: e.type, logIndex: e.logIndex, leafIndex: e.leafIndex ?? null, count: (e.leaves || e.nullifiers || e.lockLeaves || []).length, nullifier: e.nullifiers?.[0] || null, block: Number.parseInt(raw.blockNumber, 16), tx: raw.transactionHash };
  }).sort((a, b) => b.block - a.block || b.logIndex - a.logIndex);
  return { view: 'pool-events', sources: ['eth_getLogs on ConfidentialPool'], to, from: fromBlock, head, events, next: fromBlock > POOL_DEPLOY_BLOCK && windowStart - span >= head - LOG_DEPTH ? fromBlock - 1 : null, olderOn: windowStart - span < head - LOG_DEPTH ? POOL_LOGS_ETHERSCAN : null, cacheTtl: to < head - ETH_FINALITY ? FINAL : undefined };
}

// One asset: the index record plus its recent envelopes from the decoded blocks.
async function asset(id) {
  const assetId = String(id || '').toLowerCase();
  const map = await assetsById();
  const a = map.get(assetId);
  if (!a) throw new NotFound('Asset not found on mainnet');
  const sameTicker = [...map.values()].filter((x) => x.network === 'mainnet' && x.ticker === a.ticker && x.asset_id !== assetId).map((x) => ({ id: x.asset_id, verified: Boolean(x.verified) }));
  // Etch type (CETCH = confidential supply, T_PETCH = public) is the opcode of the etch transaction's envelope.
  // Only the envelope is needed, not the whole transaction view (that one also reads the bridge state from Ethereum).
  const etchOp = /^[0-9a-f]{64}$/.test(a.etch_txid || '') ? await cached(`btc:tx:${a.etch_txid}`, () => esplora(`/tx/${a.etch_txid}`), { ttlMs: 24 * 3600_000, staleMs: 24 * 3600_000 })
    .then((r) => decodeTx(r.data)?.name || null).catch(() => null) : null;
  return {
    view: 'asset', sources: ['/assets?network=mainnet'],
    id: a.asset_id, ticker: a.ticker, verified: Boolean(a.verified), decimals: a.decimals, mintable: Boolean(a.mintable), etchOp,
    etchTxid: a.etch_txid, etchedHeight: a.etched_at_height, etchedAt: a.etched_at, holders: a.holder_count ?? null, transfers: a.transfer_count ?? null,
    commitment: a.commitment || null, imageUri: null,
    // The issuer's published opening of the supply commitment (SPEC §3.3), when there is one.
    supply: a.attestation?.supply ?? null, supplyAttestedAt: a.attestation?.attested_at ?? null,
    burns: (a.burns || []).map((b) => ({ txid: b.burn_txid, amount: b.burned_amount, height: b.burned_at_height })),
    mints: (a.mints || []).map((m) => ({ txid: m.mint_txid || m.txid || null, height: m.minted_at_height || m.height || null })),
    sameTicker,
  };
}

// Every mainnet asset, verified first, then by holders. Tickers are not unique, so ids are always shown.
async function assetList() {
  const all = [...(await assetsById()).values()].filter((a) => a.network === 'mainnet')
    .sort((a, b) => Number(Boolean(b.verified)) - Number(Boolean(a.verified)) || (b.holder_count || 0) - (a.holder_count || 0));
  return {
    view: 'asset-list', sources: ['/assets?network=mainnet'],
    assets: all.map((a) => ({ id: a.asset_id, ticker: a.ticker || null, verified: Boolean(a.verified), holders: a.holder_count ?? null, transfers: a.transfer_count ?? null, etchedHeight: a.etched_at_height ?? null, decimals: a.decimals ?? null })),
  };
}

// Mainnet Bitcoin AMM pools with each side's ticker and decimals joined in, so the page needs neither raw list.
async function ammPools() {
  const [{ data }, assets] = await Promise.all([getUpstream('/amm/pools', '', { ttlMs: 30_000 }), assetsById().catch(() => new Map())]);
  const side = (id, reserve) => { const a = assets.get(String(id || '').toLowerCase()); return { id, reserve, ticker: a?.ticker || null, decimals: a?.decimals ?? null, verified: Boolean(a?.verified) }; };
  return {
    view: 'amm-pools', sources: ['/amm/pools', '/assets?network=mainnet'],
    pools: (data.pools || []).filter((p) => p.network === 'mainnet').map((p) => ({ id: p.pool_id, a: side(p.asset_a, p.reserve_a), b: side(p.asset_b, p.reserve_b), feeBps: p.fee_bps ?? null })),
  };
}

// One transaction as the address page shows it: what the address gained or lost, and any Tacit envelope.
function addressTxRow(tx, address, assets) {
  const env = decodeTx(tx);
  const out = tx.vout.filter((o) => o.scriptpubkey_address === address).reduce((a, o) => a + o.value, 0);
  const spent = tx.vin.filter((v) => v.prevout?.scriptpubkey_address === address).reduce((a, v) => a + v.prevout.value, 0);
  const asset = env?.assetId ? assets.get(env.assetId) : null;
  return {
    txid: tx.txid, height: tx.status?.block_height || null, time: tx.status?.block_time || null, confirmed: Boolean(tx.status?.confirmed),
    delta: out - spent, op: env ? env.name || env.opcodeHex : null,
    asset: env?.assetId ? { id: env.assetId, ticker: asset?.ticker || null } : null,
  };
}

// Older confirmed transactions of an address, 25 per page, on request only ("Load older"). id = "<address>:<last txid seen>".
async function btcAddressTxs(id) {
  const [address, after] = String(id || '').split(':');
  if (!isBtcAddress(address) || !/^[0-9a-f]{64}$/.test(after || '')) throw new NotFound('Expected <address>:<txid>');
  const [page, assets] = await Promise.all([
    cached(`btc:addr-txs:${address}:${after}`, () => esplora(`/address/${address}/txs/chain/${after}`), { ttlMs: DAY, staleMs: DAY }).then((r) => r.data),
    assetsById().catch(() => new Map()),
  ]);
  const rows = page.map((tx) => addressTxRow(tx, address, assets));
  return { view: 'btc-address-txs', sources: ['Esplora /address/<addr>/txs/chain/<txid>'], address, txs: rows, last: rows.at(-1)?.txid || null, more: rows.length >= 25, cacheTtl: FINAL };
}

// ---- Bitcoin address: balance and the newest transactions (Esplora), each checked for a Tacit envelope ----
// Mainnet only: bech32 / bech32m (bc1…) and base58 (1…, 3…). Esplora validates the checksum and answers 400 otherwise.
const BTC_ADDRESS = /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/;
const isBtcAddress = (s) => BTC_ADDRESS.test(s);
async function btcAddress(id) {
  const raw = String(id || '').trim();
  const address = /^bc1/i.test(raw) ? raw.toLowerCase() : raw;
  if (!isBtcAddress(address)) throw new NotFound('Not a Bitcoin mainnet address');
  const get = (path) => esplora(path).catch((e) => { if (e.status === 400 || e.status === 404) throw new NotFound('Not a valid Bitcoin address'); throw e; });
  const [info, txs, assets, bridge] = await Promise.all([
    cached(`btc:addr:${address}`, () => get(`/address/${address}`), { ttlMs: 30_000 }).then((r) => r.data),
    cached(`btc:addr-txs:${address}`, () => get(`/address/${address}/txs`), { ttlMs: 30_000 }).then((r) => r.data),
    assetsById().catch(() => new Map()), bridgeState().catch(() => ({})),
  ]);
  const sum = (s) => ({ received: s.funded_txo_sum, sent: s.spent_txo_sum, txs: s.tx_count });
  const rows = txs.map((tx) => addressTxRow(tx, address, assets));
  const chain = sum(info.chain_stats), mempool = sum(info.mempool_stats);
  return {
    view: 'btc-address', sources: ['Esplora /address/<addr>', 'Esplora /address/<addr>/txs', '/assets?network=mainnet'],
    address, balance: chain.received - chain.sent + mempool.received - mempool.sent, chain, mempool, tip: bridge.tip || null,
    txs: rows,
    more: chain.txs + mempool.txs > txs.length, last: rows.filter((t) => t.confirmed).at(-1)?.txid || null,
  };
}

module.exports = { btcTx, ethTx, btcBlock, chainBlock, chainRaw, chainList, blockList, poolEvents, asset, assetList, ammPools, btcAddress, btcAddressTxs, isBtcAddress, NotFound };
