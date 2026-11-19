// Server-side views: compact, cached projections built only from allowlisted upstream GETs.
// They keep per-visitor work small (one small JSON per section) and let the CDN share the result.
// Every view returns { view, sources, asOf, ... } so the page can show provenance.

const { getUpstream, cached, createCache, mapLimit, asLookup, traced } = require('./upstream.cjs');
const { later } = require('./background.cjs');

const lookupCache = createCache(500); // footprint results only
const { decodeTx } = require('./envelope.cjs');
const { footprint } = require('./footprint.cjs');
const detail = require('./detail.cjs');
const { rpc } = require('./rpc.cjs');
const { decodeBlock } = require('./btc-block.cjs');
const { decodedBlock, decodedBlockView } = require('./decoded-block.cjs');
const { decodePoolLogs, POOL, NULLIFIERS, POOL_BINDING } = require('./pool-logs.cjs');
const { nullifierIndex, rememberBurn } = require('./bridge-links.cjs');
const { bridgeOnChain, recentPoolEvents, ethAssets, attestedAt, CONFIRMATIONS, RELAY } = require('./chain-state.cjs');
const { reverseNames } = require('./names.cjs');
const { poolCounts, poolCountsAt, chainBlocks, bridgeMints } = require('./measured-privacy.cjs');
const BURN_SNAPSHOT = require('node:path').join(__dirname, 'data', 'burn-snapshot.json');
let burnSnap;
const loadBurns = () => (burnSnap ??= (() => { try { return JSON.parse(require('node:fs').readFileSync(BURN_SNAPSHOT, 'utf8')); } catch { return null; } })());
const { esplora, mempoolTip, ESPLORA_HOSTS, MEMPOOL_TIP } = require('./bitcoin.cjs');

// /stats wraps big integers as {"$n":"123"}. Return the decimal string (BigInt-safe), else the value.
function unwrapN(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.$n === 'string') return value.$n;
  return value;
}

// Deep unwrap, dropping time-series arrays that the page doesn't use.
function slim(value, drop = new Set(['series', 'times'])) {
  const unwrapped = unwrapN(value);
  if (unwrapped !== value) return unwrapped;
  if (Array.isArray(value)) return value.map((item) => slim(item, drop));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !drop.has(key)).map(([key, item]) => [key, slim(item, drop)]));
  }
  return value;
}

// Chain ids seen in /stats dev[]. 4663 verified with eth_chainId on rpc.mainnet.chain.robinhood.com (0x1237).
const CHAINS = { 1: 'Ethereum', 8453: 'Base', 4663: 'Robinhood' };

const EVM_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9'; // footprint.cjs CONTRACTS['EVM pool'], same address on every chain

async function evmPools() {
  // Counts and sums since deploy from this site's own EVM pool history (server/data/evm-snapshot.json.gz plus the
  // blocks after it, evm-history.cjs), and each balance straight from its chain. No Tacit API.
  const totals = await require('./evm-history.cjs').poolTotals();
  const order = [1, 8453, 4663];
  totals.sort((a, b) => order.indexOf(a.chain) - order.indexOf(b.chain));
  const live = await Promise.all(totals.map((t) => rpc(t.chain, 'eth_getBalance', [EVM_POOL, 'latest'], { ttlMs: 15_000 }).then((h) => BigInt(h).toString(), () => null)));
  return {
    view: 'evm-pools', sources: ['eth_getBalance (EVM pool contract, each chain)', 'Transact logs since deploy (deposit and withdrawal counts)'],
    asOf: { fetchedAt: Date.now(), partial: totals.some((t) => !t.live) },
    chains: totals.map((t, i) => ({
      chain: t.chain, name: t.name || CHAINS[t.chain] || null,
      balanceWei: live[i], balanceFrom: live[i] != null ? 'chain' : null, depositsWei: t.depositWei, withdrawalsWei: t.withdrawalWei,
      depositCount: t.deposits, withdrawalCount: t.withdrawals, lastAt: t.lastTime, through: t.through, live: t.live,
    })),
    // A chain still being read: never cached (CDN or here), so the card asks again in seconds and fills in.
    partial: totals.some((t) => !t.live) || undefined,
  };
}

const CONFIDENTIAL_LATEST = 30; // 6 rows of 5 tiles, the same height as the Bitcoin block grid
const ENTRY_PAYLOAD_KEYS = new Set(['leaves', 'nullifiers', 'memos']);

// ConfidentialPool: latest events from eth_getLogs and the leaf count from the contract. Totals the contract does not
// expose (nullifiers, wraps, cross-outs) come from this server's own index of the pool's logs and settle calldata
// (measured-privacy.cjs), not from Tacit's API.
async function confidential() {
  const [events, chain, own] = await Promise.all([recentPoolEvents(CONFIDENTIAL_LATEST), bridgeOnChain(), poolCounts().catch(() => null)]);
  return {
    view: 'confidential', sources: ['eth_getLogs on ConfidentialPool', 'nextLeafIndex() on ConfidentialPool', 'pool logs and settle calldata since deploy (totals)'],
    asOf: { headBlock: events.ethBlock, totalsThrough: own?.throughBlock ?? null, totalsSynced: own?.synced ?? false, fetchedAt: Date.now() },
    pool: chain.contracts.pool,
    counts: { ...(own?.counts || {}), leaves: chain.nextLeafIndex },
    entries: events.events.map((e) => ({ type: e.type, block: e.block, tx: e.tx, logIndex: e.logIndex, ...(e.leaves ? { leavesCount: e.leaves.length } : {}), ...(e.nullifiers ? { nullifiersCount: e.nullifiers.length } : {}) })),
    gaps: own?.counts ? undefined : ['pool totals'],
  };
}

const ENVELOPE_ROWS = 20;
const TX_CONCURRENCY = 12; // spread across the Esplora operators

// Every Tacit envelope in the recent Bitcoin blocks, newest first, decoded here from the raw blocks (btc-blocks); and on
// top, transfers still in the mempool. Those are only known because Tacit's wallet tells Tacit's server about each one
// it broadcasts (the /hint route in worker/src/index.js, which feeds /recent-cxfer-txids). That list is used as a hint
// only: each transaction is read from Bitcoin (Esplora), kept only while it is really unconfirmed, and decoded here.
const MEMPOOL_ROWS = 4;
async function envelopes() {
  const [blocks, hint] = await Promise.all([
    getView('/views/btc-blocks').then((r) => r.data),
    getUpstream('/recent-cxfer-txids', '?network=mainnet&limit=20', { ttlMs: 15_000 }).then((r) => r.data.entries || []).catch(() => []),
  ]);
  const rows = blocks.blocks.filter((b) => b.envelopes).flatMap((b) => b.envelopes.map((e) => ({
    txid: e.txid, assetId: e.assetId ?? null, ticker: e.ticker ?? null, op: { name: e.name, code: e.opcodeHex },
    confirmed: true, blockHeight: b.height, blockTime: b.time,
  })));
  const inBlocks = new Set(rows.map((r) => r.txid));
  const recent = hint.filter((h) => h?.txid && !inBlocks.has(h.txid) && Date.now() - Number(h.ts) < 6 * 3600_000).slice(0, 8);
  const looked = await mapLimit(recent, 4, (h, i) => cached(`btc:tx:${h.txid}`, () => esplora(`/tx/${h.txid}`, 'json', i % ESPLORA_HOSTS.length), { ttlMs: (t) => (t?.status?.confirmed ? 24 * 3600_000 : 20_000), staleMs: 60_000 }).then((r) => r.data, () => null));
  const tickers = new Map(blocks.blocks.flatMap((b) => (b.envelopes || []).filter((e) => e.assetId && e.ticker).map((e) => [e.assetId, e.ticker])));
  const mempool = recent.map((h, i) => ({ h, tx: looked[i] })).filter(({ tx }) => tx && tx.status && !tx.status.confirmed).map(({ h, tx }) => {
    const e = decodeTx(tx);
    return e ? { txid: h.txid, assetId: e.assetId ?? null, ticker: e.assetId ? tickers.get(e.assetId) || null : null, op: { name: e.name, code: e.opcodeHex }, confirmed: false, seenAt: Number(h.ts) || null } : null;
  }).filter(Boolean).slice(0, MEMPOOL_ROWS);
  return {
    view: 'envelopes', sources: ['Esplora /block/:hash/raw (decoded here)', '/recent-cxfer-txids (hint for unconfirmed transfers, each checked on Esplora)'], partial: blocks.partial,
    asOf: { fetchedAt: Date.now(), fromBlock: blocks.blocks.at(-1)?.height ?? null, toBlock: blocks.blocks[0]?.height ?? null },
    rows: [...mempool, ...rows].slice(0, ENVELOPE_ROWS + mempool.length),
  };
}

// Privacy boundary: for each operation type, one real mainnet record, the fields it actually exposes,
// and what SPEC.md §11 says stays hidden. Public fields are read from the record, not written by hand.
const short = (v, n = 10) => (v && String(v).length > 2 * n + 1 ? `${String(v).slice(0, n)}…${String(v).slice(-n)}` : v);

async function privacy() {
  const [env, conf, board] = await Promise.all([
    getView('/views/envelopes'), getView('/views/confidential').catch(() => null),
    getUpstream('/leaderboard', '', { ttlMs: 300_000 }).catch(() => null),
  ]);
  const rows = [];
  const notes = [];

  // A confirmed confidential transfer (an unconfirmed one has no block yet).
  const cx = env.data.rows.find((r) => r.confirmed && r.op && (r.op.code === '0x22' || r.op.code === '0x23'));
  const tx = cx ? await cached(`btc:tx:${cx.txid}`, () => esplora(`/tx/${cx.txid}`), { ttlMs: (t) => (t?.status?.confirmed ? 24 * 3600_000 : 30_000), staleMs: 24 * 3600_000 }).then((r) => r.data, () => null) : null;
  const e = tx && decodeTx(tx);
  if (e) {
    const inputs = new Set(tx.vin.map((v) => v.prevout?.scriptpubkey_address).filter(Boolean));
    const reused = tx.vout.some((v) => v.scriptpubkey_address && inputs.has(v.scriptpubkey_address));
    const signer = tx.vin[0]?.witness?.[1];
    rows.push({
      op: `Bitcoin ${e.name}`, chain: 'bitcoin', example: { id: cx.txid, href: `https://mempool.space/tx/${cx.txid}` },
      public: [
        ['asset id (in envelope)', short(e.assetId)], ['notes created', e.outputs], ['inputs spent', tx.vin.length],
        ['outputs', tx.vout.map((v) => `${v.scriptpubkey_type} ${v.value} sat`).join(', ')],
        ['output addresses', `${new Set(tx.vout.map((v) => v.scriptpubkey_address).filter(Boolean)).size} distinct, all public${reused ? ', one reuses an input address' : ''}`],
        ['fee', `${tx.fee} sat`], ['block', tx.status?.block_height],
        signer && ['signer key (leaf script)', short(signer.slice(2, 66))],
      ].filter(Boolean),
      hidden: ['note amounts (encrypted)', "the link from each note output to the recipient's Tacit address, for stealth receipts only"],
    });
  } else notes.push('No decodable confirmed confidential transfer in the latest envelopes.');

  // The two receipts and one depositor's points are independent: fetch them together. The depositor is a mid-table
  // entry, not the leader, so the page does not single out the largest user.
  const list = Array.isArray(board?.data) ? board.data : [];
  const top = list[Math.floor(list.length / 2)] || null;
  const entryOf = (type) => (conf?.data?.entries || []).find((x) => x.type === type);
  const [receipts, points] = await Promise.all([
    Promise.all(['leaves', 'nullifiers'].map((t) => (entryOf(t) ? rpc(1, 'eth_getTransactionReceipt', [entryOf(t).tx], { ttlMs: 3600_000 }).catch(() => null) : null))),
    top ? getUpstream(`/points/${String(top.address).toLowerCase()}`, '', { ttlMs: 60_000 }).catch(() => null) : null,
  ]);
  for (const [n, type] of ['leaves', 'nullifiers'].entries()) {
    const entry = entryOf(type);
    if (!entry) { notes.push(`No ${type} entry in the latest ConfidentialPool page.`); continue; }
    const receipt = receipts[n];
    if (!receipt) { notes.push(`The ${type} example's receipt could not be read right now.`); continue; }
    const raw = decodePoolLogs(receipt).find((l) => l.logIndex === entry.logIndex) || {};
    const pub = [['tx', short(entry.tx)], ['block', entry.block], ['log index', entry.logIndex]];
    if (type === 'leaves') {
      pub.push(['leaf index', raw.leafIndex], ['leaf commitment', short(raw.leaves?.[0])], ['memo', !raw.memoBytes?.[0] ? 'empty' : `${raw.memoBytes[0]} bytes of ciphertext`]);
    } else pub.push(['nullifier', short(raw.nullifiers?.[0])]);
    rows.push({
      op: type === 'leaves' ? 'ConfidentialPool note created' : 'ConfidentialPool note spent', chain: 'ethereum',
      example: { id: entry.tx, href: `https://etherscan.io/tx/${entry.tx}` }, public: pub,
      hidden: type === 'leaves' ? ['note amount', 'note owner (memo is encrypted to the recipient)'] : ['which note was spent (owned notes)', 'amount'],
    });
  }

  const deposits = points?.data?.deposits;
  const dep = deposits?.[0];
  if (dep) {
    const explorer = { 1: 'https://etherscan.io', 8453: 'https://basescan.org', 4663: 'https://explorer.mainnet.chain.robinhood.com' }[dep.chain_id];
    rows.push({
      op: 'EVM pool deposit', chain: CHAINS[dep.chain_id] || `chain ${dep.chain_id}`, example: { id: dep.tx_hash, href: explorer ? `${explorer}/tx/${dep.tx_hash}` : null },
      public: [['depositor address', 'public, on the transaction'], ['amount', `${dep.amount_wei} wei`], ['chain', CHAINS[dep.chain_id] || dep.chain_id], ['time', new Date(dep.block_time * 1000).toISOString()]],
      hidden: ['transfers inside the pool', 'which later withdrawal (if any) it funds'],
      // Not SPEC §11: the EVM pool is a separate system (Tacit docs/EVM-POOL.md, which also gives this caveat).
      note: 'The EVM pool is a separate system that the spec’s privacy section does not cover. Its amounts show at both ends, so an equal amount withdrawn soon after a deposit can link the two (Tacit docs/EVM-POOL.md).',
    });
  } else notes.push('No EVM pool deposit example available.');

  return {
    view: 'privacy', sources: ['/views/envelopes (decoded Bitcoin blocks)', 'Esplora /tx/<txid>', '/views/confidential', 'eth_getTransactionReceipt', '/leaderboard', '/points/<address>', 'SPEC.md §11'],
    asOf: { fetchedAt: Date.now() }, rows, notes,
    specPublic: ['Bitcoin addresses and the transaction graph', 'asset ids on Bitcoin transfers', "the pool's deposit and withdrawal boundary", 'AMM reserves', 'burn amounts'],
    // Public by other sections of SPEC, not listed in §11.
    specAlsoPublic: ['Wrap amounts, in the Wrap log (§4.3)', 'fair-launch caps and mints (§3.4)', 'the input amount of a T_SWAP_VAR (§3.5)', 'cBTC lock values (§3.6)', 'relay fees (§5.4)', 'loan collateral and debt (§5.7)'],
    specNote: "Hidden means hidden from the chain. Whoever proves a batch sees its amounts (SPEC §11); today that is usually Tacit's prover, unless the user proves on their own device.",
    specHidden: ['amounts on both chains', 'which note a pool spend consumes (owned notes)', 'trade sizes in blind swaps and batch swaps', 'recipient identity for stealth receipts'],
  };
}

// Bridge state: heights and roots from the Ethereum contracts; burn/mint bookkeeping (off-chain) from the Tacit API.
// Every bridge burn since the bridge launched and which of them are minted, from chains alone: the burns from the
// Bitcoin scan (server/data/burn-snapshot.json, scripts/burn-snapshot.mjs), then the blocks after it (the decoded
// block window, and any blocks between the two, decoded here). A burn is minted once a bridge mint's settle call
// consumed its nullifier (pool index). Null without a snapshot.
const BURN_GAP_MAX = 300; // blocks between the snapshot and the window decoded on demand (the snapshot is refreshed before deploy)
async function bridgeTotals() {
  const snap = loadBurns();
  if (!snap) return null;
  const [blocks, mints] = await Promise.all([getView('/views/btc-blocks').then((r) => r.data), bridgeMints()]);
  const window = blocks.blocks.filter((b) => b.envelopes && b.height > snap.through);
  const windowFrom = Math.min(...window.map((b) => b.height), blocks.asOf.tip + 1);
  const gap = [];
  for (let h = snap.through + 1; h < windowFrom && gap.length < BURN_GAP_MAX; h += 1) gap.push(h);
  const gapBlocks = await mapLimit(gap, 6, async (h, i) => {
    const hash = (await cached(`btc:hash:${h}`, async () => String(await esplora(`/block-height/${h}`, 'text', i % ESPLORA_HOSTS.length)).trim(), { ttlMs: 24 * 3600_000 })).data;
    const d = (await decodedBlock(hash, i % ESPLORA_HOSTS.length)).data;
    return { height: h, envelopes: d.envelopes };
  });
  const complete = gap.length === windowFrom - snap.through - 1 && gapBlocks.every((b) => b && !b.error);
  const fresh = [...gapBlocks.filter((b) => b && !b.error), ...window].flatMap((b) => b.envelopes.filter((e) => e.name === 'bridge burn').map((e) => ({ txid: e.txid, height: b.height, nullifier: e.nullifier || null, binding: e.binding || null })));
  // Only burns that name this pool's deployment (a burn for another deployment can never be minted here).
  const byTx = new Map([...snap.burns, ...fresh].filter((b) => b.binding === POOL_BINDING).map((b) => [b.txid, b]));
  const minted = new Set(mints.map(([nu]) => nu));
  const burns = [...byTx.values()];
  const unminted = burns.filter((b) => !b.nullifier || !minted.has(String(b.nullifier).toLowerCase()));
  return { burns: burns.length, minted: burns.length - unminted.length, mints: mints.length, unminted, complete };
}

// The bridge card must not wait on a cold block window: this site's burn total gets a short budget, and when it is not
// ready the card shows Tacit's figures for that one answer while the total keeps building for the next.
const quickTotals = () => { const p = bridgeTotals().catch(() => null); later(p); return Promise.race([p, new Promise((r) => setTimeout(() => r(null), 1_500).unref?.())]); };

async function bridgeState() {
  const [chain, api, own] = await Promise.all([
    bridgeOnChain(),
    getUpstream('/reflection/status', '', { ttlMs: 15_000 }).then((r) => r.data).catch(() => null),
    quickTotals(),
  ]);
  return {
    view: 'bridge-state', sources: ['BitcoinLightRelay + ConfidentialPool (eth_call)', 'Bitcoin burns since launch + settle calldata (burns minted)', '/reflection/status (awaiting bundle, relay notes)'],
    // Same field names as /reflection/status so sections read one shape; heights and burn totals are this site's own.
    ...(api || {}), ...(own ? { bridgeBurns: own.burns, bridgeMinted: own.minted, burnsFrom: 'chain', burnsComplete: own.complete } : { burnsFrom: api ? 'tacit' : null }), tipHeight: chain.relayTipHeight,
    ...(own ? {} : { cacheTtl: 5 }), // answered with Tacit's figures: ask again soon attestedHeight: chain.attestedHeight, confirmations: api?.confirmations ?? CONFIRMATIONS,
    attestableHeight: chain.attestableHeight, lagBlocks: chain.attestableHeight - chain.attestedHeight, // 0 = caught up
    chain, api: api ? { tipHeight: api.tipHeight, attestedHeight: api.attestedHeight, updatedAt: api.updatedAt } : null,
    gaps: api ? undefined : ['burn and mint bookkeeping (Tacit API)'],
  };
}

// Independent chain checks: compare API figures against public chain endpoints.
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error: String(error.message || error) }));

async function checks() {
  const [chainBridge, api, index, btcTip] = await Promise.all([
    settle(bridgeOnChain()),
    settleR(getUpstream('/reflection/status', '', { ttlMs: 15_000 })),
    settleR(getUpstream('/confidential/index', '?limit=1', { ttlMs: 120_000, staleMs: 3600_000 })),
    settle(mempoolTip()),
  ]);
  // Tacit's newest chain block against this site's rebuild at the same height: a divergence (a block numbered or
  // hashed differently) shows here at once.
  const tacitHead = await settleR(getUpstream('/prover/blocks', '?limit=1', { ttlMs: 30_000, staleMs: 3600_000 }));
  const tacitTop = tacitHead.value?.head;
  const ownAtTop = tacitTop ? await settle(chainBlocks({ limit: 1, before: tacitTop.height + 1 })) : null;
  const tacitBlock = index.value?.indexedToBlock;
  const own = tacitBlock ? await settle(poolCountsAt(tacitBlock)) : { error: index.error || 'Tacit index did not say how far it has read' };
  const rows = [];
  const add = (figure, api, chain, apiSource, chainSource, compare, repro = []) => {
    const row = { figure, api: api.value ?? null, chain: chain.value ?? null, apiSource, chainSource, error: api.error || chain.error || null, repro };
    // A figure the source did not report is not zero; an API answer served from cache is not compared with a live read.
    if (row.error) { /* shown as the error */ } else if (row.api == null || row.chain == null) Object.assign(row, { status: 'not reported' });
    else if (api.stale) Object.assign(row, { status: 'stale', note: `the API answer is from ${new Date(api.savedAt).toISOString().slice(11, 16)} UTC; not compared` });
    else Object.assign(row, compare(row.api, row.chain));
    rows.push(row);
  };
  // Commands a visitor can paste to fetch both numbers of a row themselves (Foundry's cast, curl, jq).
  const RPC = '--rpc-url https://ethereum-rpc.publicnode.com';
  const relayTipCmd = `cast call ${RELAY} "tipHeight()(uint256)" ${RPC}`;
  const attestedTipCmd = `cast call ${POOL} "attestedReflectionTip()(bytes32)" ${RPC}`;
  const blocks = (a, c, ok = 2, word = 'behind') => ({ diff: c - a, unit: 'blocks', status: Math.abs(c - a) <= ok ? 'match' : word });
  // Chain against chain: the relay contract and the pool's attested tip against Bitcoin itself.
  // The relay is paced on purpose (worker-relay/src/header-relay.js): it targets min(Bitcoin tip − 2, attested + headerLead)
  // and waits for cheap gas, so a gap here is expected and reported as information, not as a fault.
  add('Relay tip on Ethereum vs Bitcoin', settle0(chainBridge, (b) => b.relayTipHeight), btcTip, 'BitcoinLightRelay.tipHeight()', 'Esplora tip height',
    (a, c) => ({ diff: c - a, unit: 'blocks', status: c - a <= 2 ? 'match' : 'paced' }),
    [relayTipCmd, "curl -s https://mempool.space/api/blocks/tip/height"]);
  const attestedHash = chainBridge.value ? await settle(esplora(`/block-height/${chainBridge.value.attestedHeight}`, 'text').then((h) => String(h).trim())) : { error: chainBridge.error };
  add('Attested block hash', settle0(chainBridge, (b) => b.attestedTipHash), attestedHash, 'ConfidentialPool.attestedReflectionTip()', 'Esplora hash at that height',
    (a, c) => ({ diff: 0, unit: 'hash', status: a === c ? 'match' : 'differs' }),
    [`${attestedTipCmd}  # byte-reversed`, `curl -s https://mempool.space/api/block-height/${chainBridge.value?.attestedHeight ?? '<height>'}`]);
  // Tacit API against the contracts.
  add('Tacit API attestable tip', settle0(api, (b) => b.tipHeight), settle0(chainBridge, (b) => b.attestableHeight), '/reflection/status tipHeight', `Relay tip − ${CONFIRMATIONS} confirmations`, (a, c) => blocks(a, c, 0, 'differs'),
    ['curl -s https://api.tacit.finance/reflection/status | jq .tipHeight', `echo $(( $(${relayTipCmd}) - ${CONFIRMATIONS} ))`]);
  add('Tacit API attested height', settle0(api, (b) => b.attestedHeight), settle0(chainBridge, (b) => b.attestedHeight), '/reflection/status attestedHeight', 'Relay blockHeight(attested tip)', (a, c) => blocks(a, c, 0, 'differs'),
    ['curl -s https://api.tacit.finance/reflection/status | jq .attestedHeight', `cast call ${RELAY} "blockHeight(bytes32)(uint256)" $(${attestedTipCmd}) ${RPC}`]);
  // Tacit's pool index against this site's own count from the chain (pool logs and settle calldata): every note and
  // lock spend since deploy, both taken at the Ethereum block Tacit's index has read to, so the two are like for like.
  const spends = (c) => (c ? (c.nullifiers || 0) + (c.lockNullifiers || 0) : null);
  add('Pool spends', index.error ? { error: index.error } : { value: spends(index.value?.counts) },
    own.error ? { error: own.error } : { value: spends(own.value?.counts) }, '/confidential/index counts', 'Pool logs and settle calldata, same block',
    (a, c) => ({ diff: c - a, unit: 'spends', status: a === c ? 'match' : 'differs' }),
    ["curl -s 'https://api.tacit.finance/confidential/index?limit=1' | jq '.indexedToBlock, .counts.nullifiers + .counts.lockNullifiers'", 'node scripts/privacy-snapshot.mjs  # recounts every spend from Ethereum and compares']);
  const ownBlock = ownAtTop?.value?.blocks?.[0];
  add('Newest Tacit chain block', tacitHead.error ? { error: tacitHead.error } : { value: tacitTop?.hash ? String(tacitTop.hash).toLowerCase() : null },
    ownAtTop?.error ? { error: ownAtTop.error } : { value: ownBlock && ownBlock.height === tacitTop?.height ? ownBlock.hash : null }, '/prover/blocks head', 'Rebuilt here from pool logs and settle calldata',
    (a, c) => ({ diff: 0, unit: 'hash', status: a === c ? 'match' : 'differs' }),
    ["curl -s 'https://api.tacit.finance/prover/blocks?limit=1' | jq -r '.head.height, .head.hash'", 'node scripts/privacy-snapshot.mjs --full  # rebuilds every block from Ethereum and compares']);
  const chainRow = rows.at(-1);
  // Tacit's burn and mint bookkeeping against this site's own count (Bitcoin burns since launch, settle calldata mints).
  const own2 = await settle(quickTotals().then((t) => t || Promise.reject(new Error('still reading the Bitcoin blocks'))));
  // Mints are compared; burn totals are not, because they count different things: Tacit's is its reflection's burn set
  // (including a few burns made for an older deployment), this site's counts burns that name this pool.
  add('Bridge burns minted', api.error ? { error: api.error } : { value: api.value?.bridgeMinted ?? null }, own2.error ? { error: own2.error } : { value: own2.value ? own2.value.minted : null },
    '/reflection/status bridgeMinted', 'Bitcoin burns for this pool, minted by settle calls',
    (a, c) => ({ diff: c - a, unit: 'mints', status: a === c ? 'match' : 'behind', ...(a === c ? {} : { note: 'a mint in the last few blocks can reach one side first' }) }),
    ["curl -s https://api.tacit.finance/reflection/status | jq .bridgeMinted", 'node scripts/burn-snapshot.mjs && node scripts/privacy-snapshot.mjs']);
  if (!chainRow.error && chainRow.chain == null && tacitTop) Object.assign(chainRow, { status: 'stale', note: 'this site has not read that block yet; compared once it has' });
  const last = rows.at(-2);
  if (!last.error && last.chain == null && own.value) Object.assign(last, { status: 'stale', note: own.value.readTo < tacitBlock ? `this site has read to block ${own.value.readTo.toLocaleString('en-US')}, Tacit to ${tacitBlock.toLocaleString('en-US')}; compared when both have` : `Tacit's index is more than 2 hours behind; not compared` });
  // Two groups for the page: Tacit's API against the chain, and the bridge on Ethereum against Bitcoin itself. Each
  // row gets a short label and, where it needs one, the block it was taken at.
  const META = {
    'Relay tip on Ethereum vs Bitcoin': ['bridge', 'Relay tip'],
    'Attested block hash': ['bridge', 'Attested block'],
    'Tacit API attestable tip': ['api', 'Attestable height'],
    'Tacit API attested height': ['api', 'Attested height'],
    'Pool spends': ['api', 'Pool spends', tacitBlock ? `at Ethereum block ${tacitBlock.toLocaleString('en-US')}` : ''],
    'Newest Tacit chain block': ['api', 'Newest Tacit chain block', tacitTop ? `block ${tacitTop.height.toLocaleString('en-US')}` : ''],
    'Bridge burns minted': ['api', 'Bridge mints'],
  };
  for (const r of rows) { const [group, label, sub] = META[r.figure] || ['api', r.figure]; Object.assign(r, { group, label, ...(sub ? { sub } : {}) }); }
  return { view: 'checks', sources: ['BitcoinLightRelay + ConfidentialPool (eth_call)', '/reflection/status', '/confidential/index (checked, not used)', 'ConfidentialPool logs and settle calldata', 'public RPCs', MEMPOOL_TIP], asOf: { fetchedAt: Date.now() }, rows };
}
function settle0(result, pick) { return result.error ? { error: result.error } : { value: pick(result.value) ?? null, stale: result.stale, savedAt: result.savedAt }; }
// A view answer counts as stale when its cache served a fallback or the view says its own inputs were.
const settleR = (p) => p.then((r) => ({ value: r.data, stale: r.stale || r.data?.stale === true, savedAt: r.data?.staleSince ?? r.savedAt }), (error) => ({ error: String(error.message || error) }));

// Bridge lag over the last 24 hours: how far the relay's Bitcoin tip trailed the real Bitcoin tip. The relay's own
// tip updates come from its logs (TipUpdated-style event: topic below, data word 0 = new tip height); Bitcoin tip times
// from Esplora block timestamps. The attested height has no event and old contract reads need an archive node, so
// only its current value is sent.
const RELAY_TIP_TOPIC = '0xb24e7c4b370076d610ad3ad05e5a17cc7bc35001baafd698b99e0f231fb7351f';
const LAG_HOURS = 24;
async function bridgeLag() {
  const [head, chain, btcTip] = await Promise.all([rpc(1, 'eth_blockNumber', [], { ttlMs: 10_000 }).then((h) => Number.parseInt(h, 16)), bridgeOnChain(), mempoolTip()]);
  // ~31 h of Ethereum blocks: enough to know the relay tip at the start of the window. Under the RPCs' log depth.
  const logs = await rpc(1, 'eth_getLogs', [{ address: RELAY, topics: [RELAY_TIP_TOPIC], fromBlock: `0x${(head - 9_300).toString(16)}`, toBlock: `0x${head.toString(16)}` }], { ttlMs: 60_000 });
  const ethBlocks = [...new Set(logs.map((l) => l.blockNumber)), `0x${head.toString(16)}`];
  const stamps = new Map(await Promise.all(ethBlocks.map((b) => rpc(1, 'eth_getBlockByNumber', [b, false], { ttlMs: 24 * 3600_000, store: 'chain' }).then((x) => [b, Number.parseInt(x.timestamp, 16)]))));
  const end = stamps.get(`0x${head.toString(16)}`), start = end - LAG_HOURS * 3600;
  const relay = logs.map((l) => [stamps.get(l.blockNumber), Number(BigInt(`0x${l.data.slice(2, 66)}`))]).sort((a, b) => a[0] - b[0]);
  // Bitcoin tip over time: pages of 10 blocks, newest first, until the page starts before the window. A page of
  // buried blocks never changes, so it is kept for a day.
  const btc = [];
  // The first page follows the tip; the rest sit on fixed boundaries (heights ending in 9), so they keep their cache
  // key from block to block instead of being fetched again for every new tip.
  for (let h = btcTip, first = true; h > 0 && btc.length < 400; h = first ? Math.floor((btcTip - 10) / 10) * 10 + 9 : h - 10, first = false) {
    const page = (await cached(`btc:blocks-page:${h}`, () => esplora(`/blocks/${h}`), { ttlMs: h <= btcTip - 6 ? 24 * 3600_000 : 60_000, store: 'chain' })).data;
    btc.push(...page.map((b) => [b.timestamp, b.height]));
    if (!page.length || page.at(-1).timestamp < start - 2 * 3600) break;
  }
  btc.sort((a, b) => a[0] - b[0]);
  for (let i = btc.length - 1; i > 0; i--) if (btc[i][1] === btc[i - 1][1]) btc.splice(i, 1); // the first two pages overlap
  // Attested height through the window: one historical read every 150 Ethereum blocks (~30 min), on fixed block
  // numbers so each stays cached, plus the head's own value. A sample that fails is left out (the line bridges it).
  // The first sample falls at or before the window's start, so the line starts at the left edge.
  const SAMPLE = 150, first = Math.floor((head - Math.ceil((end - start) / 12)) / SAMPLE) * SAMPLE;
  const marks = [];
  for (let b = first; b <= head - 64; b += SAMPLE) marks.push(b);
  const attestedSeries = (await Promise.all(marks.map((b) => attestedAt(b).then((h) => [end - (head - b) * 12, h], () => null)))).filter(Boolean);
  attestedSeries.push([end, chain.attestedHeight]);
  return {
    view: 'bridge-lag', sources: ['BitcoinLightRelay logs (tip updates)', 'Esplora /blocks (block times)', 'ConfidentialPool attestedReflectionTip every ~30 min (historical eth_call) + BitcoinLightRelay'],
    start, end, relay, btc: btc.filter(([t]) => t >= start - 2 * 3600), attested: chain.attestedHeight, attestedSeries, relayTip: chain.relayTipHeight, btcTip, confirmations: CONFIRMATIONS,
  };
}

// Bridge burns on their way to Ethereum: every bridge burn in the recent decoded Bitcoin blocks, and how far each
// has got. Burned → confirmed (24 deep on Bitcoin) → relayed (Ethereum's relay is 24 past it, so it can be
// attested) → attested (≤ the pool's attested height) → minted. A mint spends the burn's ν (its nullifier, read from
// the envelope), so a burn is minted once its ν is in the pool's NullifiersSpent logs (last ~30 h, under the RPCs'
// log depth).
const pendingBurns = new Map(); // txid -> burn: unminted burns already seen, kept until minted
async function bridgeBurns() {
  const [blocks, head] = await Promise.all([getView('/views/btc-blocks').then((r) => r.data), rpc(1, 'eth_blockNumber', [], { ttlMs: 10_000 }).then((h) => Number.parseInt(h, 16))]);
  const tip = blocks.asOf.tip, relayTip = Number(blocks.asOf.relayTip), attested = Number(blocks.asOf.attestedHeight), need = blocks.asOf.confirmations || CONFIRMATIONS;
  const inWindow = blocks.blocks.flatMap((b) => (b.envelopes || []).filter((e) => e.name === 'bridge burn').map((e) => ({ txid: e.txid, height: b.height, time: b.time, ticker: e.ticker || null })));
  // Unminted burns seen before stay listed after they leave the decoded window, until their mint shows up.
  const seen = new Set(inWindow.map((b) => b.txid));
  const found = [...inWindow, ...[...pendingBurns.values()].filter((b) => !seen.has(b.txid))];
  const { map: spentIn } = await nullifierIndex();
  const burns = await Promise.all(found.map(async (b) => {
    const tx = await cached(`btc:tx:${b.txid}`, () => esplora(`/tx/${b.txid}`), { ttlMs: (t) => (t?.status?.confirmed ? 24 * 3600_000 : 30_000), staleMs: 24 * 3600_000 }).then((r) => r.data, () => null);
    const nu = tx ? decodeTx(tx)?.nullifier || null : null;
    const confirmations = tip - b.height + 1;
    rememberBurn(nu, { txid: b.txid, height: b.height });
    const mint = nu ? spentIn.get(nu) : undefined;
    const step = mint ? 5 : b.height <= attested ? 4 : Number.isFinite(relayTip) && relayTip >= b.height + need ? 3 : confirmations >= need ? 2 : 1;
    return { ...b, confirmations, step, mintTx: mint?.tx || null, mintTime: mint?.time ?? null, known: Boolean(nu) };
  }));
  burns.sort((a, b) => a.height - b.height || a.txid.localeCompare(b.txid)); // oldest first: furthest along
  for (const b of burns) { if (b.step === 5) pendingBurns.delete(b.txid); else pendingBurns.set(b.txid, { txid: b.txid, height: b.height, time: b.time, ticker: b.ticker }); }
  // A fresh instance has not seen older burns: say how many Tacit reports as not yet minted beyond those listed.
  const own = await quickTotals(); // short budget, as on the bridge card; without it the answer is partial and refills
  const listed = new Set(burns.map((b) => b.txid));
  const waitingListed = burns.filter((b) => b.step < 5).length;
  // Typical burn-to-mint wait: the median over the minted burns in view (mint time estimated from its block).
  const waits = burns.filter((b) => b.step === 5 && b.mintTime && b.time).map((b) => b.mintTime - b.time).filter((w) => w > 0).sort((a, b) => a - b);
  const typicalWait = waits.length ? waits[Math.floor(waits.length / 2)] : null;
  const notMinted = own ? own.unminted.length : null;
  return {
    view: 'bridge-burns', sources: ['Bitcoin blocks decoded here (bridge burn envelopes and their ν)', 'ConfidentialPool NullifiersSpent logs (mints)', 'BitcoinLightRelay + ConfidentialPool (heights)'],
    tip, relayTip, attested, confirmations: need, ethBlock: head, windowFrom: blocks.blocks.at(-1)?.height ?? null, burns,
    typicalWait, typicalOf: waits.length,
    olderUnminted: own ? own.unminted.filter((b) => !listed.has(b.txid)).length : 0,
    partial: blocks.partial || !own || undefined, // blocks still decoding, or the burn total not ready: kept briefly, filled on the next build
  };
}

// Recent Bitcoin blocks decoded from raw bytes (Esplora), every Tacit envelope of every op type,
// plus where each block stands in the bridge: attested to Ethereum, or still waiting.
const BLOCK_WINDOW_MIN = 48; // 8 rows of 6 tiles: usually reaches past the attested height
const BLOCK_BUDGET_MS = 3_000; // answer fast; blocks still decoding are marked and the answer is kept only briefly (partial)
const BLOCK_WINDOW_MAX = 60; // reach a few blocks past the attested height so the crossing shows

async function btcBlocks() {
  const [tip, bridge, assets] = await Promise.all([
    mempoolTip(),
    bridgeOnChain().then((c) => ({ attestedHeight: c.attestedHeight, tipHeight: c.relayTipHeight, confirmations: CONFIRMATIONS }))
      // /reflection/status tipHeight is the attestable height (relay tip − 24): turn it back into the relay tip.
      .catch(() => getUpstream('/reflection/status', '', { ttlMs: 10_000 }).then((r) => r.data && ({ ...r.data, tipHeight: r.data.tipHeight != null ? Number(r.data.tipHeight) + (Number(r.data.confirmations) || CONFIRMATIONS) : null })).catch(() => null)),
    getUpstream('/assets', '?network=mainnet', { ttlMs: 60_000 }).then((r) => r.data.assets || []).catch(() => []),
  ]);
  const attestedAt = Number(bridge?.attestedHeight);
  const want = Math.min(BLOCK_WINDOW_MAX, Math.max(BLOCK_WINDOW_MIN, Number.isFinite(attestedAt) ? tip - attestedAt + 4 : BLOCK_WINDOW_MIN));
  const pages = await Promise.all(Array.from({ length: Math.ceil(want / 10) + 1 }, (_, i) => esplora(`/blocks/${tip - i * 10}`)));
  const list = pages.flat().filter((b, i, all) => all.findIndex((x) => x.id === b.id) === i).sort((a, b) => b.height - a.height).slice(0, want);
  // Seed the block page's caches with what Esplora's /blocks already returned (same shape as /block/:hash), so a
  // visitor tapping a tile does not wait for these again. Confirmed headers never change.
  // A height's hash is kept for a day only once the block is 6 deep (a reorg can replace a shallower one).
  for (const b of list) { cached(`btc:hash:${b.height}`, async () => b.id, { ttlMs: tip - b.height + 1 >= 6 ? 24 * 3600_000 : 60_000 }); cached(`btc:block:${b.id}`, async () => b, { ttlMs: 24 * 3600_000 }); }
  const tickers = new Map(assets.map((a) => [a.asset_id, a.ticker]));
  // Confirmed blocks never change: decode each once and keep it for a day (reorgs deeper than the window are not handled).
  // Answer within the time budget with what is decoded; slower blocks keep loading into the cache for the next build.
  const done = new Array(list.length).fill(null);
  const work = mapLimit(list, 6, (b, i) => decodedBlock(b.id, i % ESPLORA_HOSTS.length)
    .then((r) => { done[i] = r; return r; }, (error) => { done[i] = { error }; return done[i]; }));
  later(work);
  await Promise.race([work, new Promise((resolve) => setTimeout(resolve, BLOCK_BUDGET_MS))]);
  const decoded = done.map((r) => r || { error: new Error('still loading') });
  const attested = Number(bridge?.attestedHeight);
  const confirmations = Number(bridge?.confirmations) || CONFIRMATIONS;
  const relayTip = Number(bridge?.tipHeight);
  return {
    partial: done.some((r) => !r) || undefined,
    view: 'btc-blocks', sources: ['Esplora /blocks, /block/:hash/raw (decoded here)', 'attested height from ConfidentialPool + BitcoinLightRelay', '/assets?network=mainnet'],
    asOf: { tip, attestedHeight: Number.isFinite(attested) ? attested : null, relayTip: bridge?.tipHeight ?? null, confirmations, fetchedAt: Date.now() },
    blocks: list.map((b, i) => {
      const d = decoded[i]?.data;
      return {
        height: b.height, hash: b.id, time: b.timestamp, txCount: b.tx_count,
        // attested: the SP1 bridge has proven this block to Ethereum. eligible: the relay on Ethereum has it 24 deep
        // (attestable = relay tip − 24), not yet attested. confirming: not that deep in the relay yet.
        bridge: !Number.isFinite(attested) ? null : b.height <= attested ? 'attested' : Number.isFinite(relayTip) && b.height <= relayTip - confirmations ? 'eligible' : 'confirming',
        confirmations: tip - b.height + 1,
        envelopes: d ? d.envelopes.map((e) => ({ ...e, ticker: e.assetId ? tickers.get(e.assetId) || null : null })) : null,
        error: decoded[i]?.error ? `not decoded yet: ${String(decoded[i].error.message || decoded[i].error)}` : (d && d.hash !== b.id ? 'hash mismatch' : null),
      };
    }),
  };
}

// Ethereum-side assets: contract reads first, /stats lock and position counts as optional context.
async function ethAssetsView() {
  const [chain, stats] = await Promise.all([
    ethAssets(),
    getUpstream('/stats', '?view=front', { ttlMs: 30_000 }).then((r) => slim(r.data)).catch(() => null),
  ]);
  const btc = stats?.btc || null;
  return {
    view: 'eth-assets', sources: ['ConfidentialPool.cbtcBackingSats()', 'CollateralEngine.outstandingCusd()', 'ERC-20 totalSupply()', '/stats?view=front (lock and position counts)'],
    asOf: { ethBlock: chain.ethBlock, fetchedAt: Date.now() }, ...chain,
    counts: btc ? { locks: btc.nLocked, mintedLocks: btc.nMint, bonds: btc.nBonds, bondWei: btc.bonds, openPositions: btc.open, borrowed: btc.borrowed, repaid: btc.repaid, liquidated: btc.liq } : null,
    gaps: btc ? undefined : ['lock and position counts (Tacit API)'],
  };
}

// Relayed ops: what Tacit's settle relay did per day (its own books, posted with its heartbeat; /relay/economics).
async function relayOps() {
  const { data } = await getUpstream('/relay/economics', '', { ttlMs: 60_000 });
  const ledger = data.ledger || {};
  return {
    view: 'relay-ops', sources: ['/relay/economics (settle relay books)'],
    asOf: { updatedAt: data.updatedAt || null, since: ledger.since || null },
    days: (ledger.recent || []).slice(-8).reverse().map((d) => ({ date: d.date, settled: d.settled, priced: d.priced, unpriced: d.unpriced, proveOnly: d.proveOnly, gasEth: d.gasEth, buybackEth: d.buybackEth })),
    // The relay wallets settle for users, so a relayed transaction's sender is the relayer, not the user.
    relayers: ['0x7a0f0511e1dcf399c2f7bbe8414b6a0d1abc4331', '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7'],
  };
}

// Names for EVM addresses: known Tacit contracts and relayers, then verified reverse names (XNS, ENS, WNS, GNS).
// ?q=addr,addr,… (max 20). Known Tacit contracts are not looked up: they have no names.
async function names(q) {
  const addrs = [...new Set(String(q || '').toLowerCase().split(',').map((a) => a.trim()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))].slice(0, 20);
  const { CONTRACTS } = require('./footprint.cjs');
  const out = {};
  await Promise.all(addrs.map(async (a) => {
    const label = CONTRACTS[a] || null;
    const found = label && !/relayer|wallet/i.test(label) ? [] : await cached(`names:${a}`, () => reverseNames(a), { ttlMs: 3600_000, staleMs: 6 * 3600_000 }).then((r) => r.data).catch(() => []);
    out[a] = { label, name: found[0]?.name || null, names: found };
  }));
  return { view: 'names', sources: ['known Tacit addresses', 'XNS, ENS, WNS and GNS reverse records (Ethereum RPC)'], names: out };
}

// Activity strip on the Tacit chain page: the newest 200 blocks with their Ethereum timestamps (each block is one
// Ethereum transaction; its time is that block's). Timestamps never change, so each is cached for a day; the batched
// RPC layer sends the lookups a few dozen per request.
async function chainActivity() {
  const first = await require('./measured-privacy.cjs').chainBlocks({ limit: 200 });
  const blocks = first.blocks || [];
  const times = new Map(await mapLimit([...new Set(blocks.map((b) => b.ethBlock))], 50, async (n) => [n, await rpc(1, 'eth_getBlockByNumber', [`0x${n.toString(16)}`, false], { ttlMs: 24 * 3600_000, store: 'chain' }).then((b) => Number.parseInt(b.timestamp, 16), () => null)]));
  return {
    view: 'chain-activity', sources: ['Tacit chain rebuilt from Ethereum (this site)', 'eth_getBlockByNumber (timestamps)'],
    head: first.head?.height ?? null,
    blocks: blocks.map((b) => ({ h: b.height, t: times.get(b.ethBlock) ?? null, n: b.notes, s: b.spent })).filter((b) => b.t),
  };
}

const VIEWS = {
  '/views/chain-activity': { build: chainActivity, ttl: 60 },
  '/views/evm-pools': { build: evmPools, ttl: 30 },
  '/views/confidential': { build: confidential, ttl: 20, selfStale: true },
  '/views/bridge-state': { build: bridgeState, ttl: 15 },
  '/views/envelopes': { build: envelopes, ttl: 15 },
  // The newest Tacit chain blocks for the home card, from this site's own rebuild (Tacit's /prover/blocks shape).
  '/views/chain-recent': { build: async () => ({ view: 'chain-recent', sources: ['Tacit chain rebuilt from Ethereum (this site)'], ...(await require('./measured-privacy.cjs').chainBlocks({ limit: 8 })) }), ttl: 15 },
  '/views/privacy': { build: privacy, ttl: 60 },
  '/views/checks': { build: checks, ttl: 15, selfStale: true },
  '/views/btc-blocks': { build: btcBlocks, ttl: 30 },
  '/views/eth-assets': { build: ethAssetsView, ttl: 60 },
  '/views/relay-ops': { build: relayOps, ttl: 60 },
  '/views/bridge-lag': { build: bridgeLag, ttl: 60 },
  '/views/bridge-burns': { build: bridgeBurns, ttl: 30 },
  '/views/measured-privacy': { build: require('./measured-privacy.cjs').measuredPrivacy, ttl: 300 },
  '/views/withdrawal-check': { build: (q) => require('./evm-history.cjs').withdrawalCheck(q), ttl: 60, param: 'q' },
  '/views/evm-activity': { build: require('./measured-privacy.cjs').evmActivity, ttl: 30 },
  '/views/traced': { build: require('./measured-privacy.cjs').tracedList, ttl: 120 },
  '/views/names': { build: names, ttl: 3600, param: 'q' },
  '/views/btc-block-decoded': { build: decodedBlockView, ttl: 3600, param: 'id' }, // one block's envelopes, CDN-cached for a year (decoded-block.cjs)
  // Parameterised: ?q=<query>. Classified and validated before any upstream call.
  '/views/footprint': { build: footprint, ttl: 30, param: 'q' },
  // Detail pages: ?id=<txid | 0x hash | height>
  '/views/btc-tx': { build: detail.btcTx, ttl: 30, param: 'id' },
  '/views/eth-tx': { build: detail.ethTx, ttl: 300, param: 'id' },
  '/views/btc-block': { build: detail.btcBlock, ttl: 60, param: 'id' },
  '/views/chain-block': { build: detail.chainBlock, ttl: 300, param: 'id' },
  '/views/chain-raw': { build: detail.chainRaw, ttl: 300, param: 'id' },
  '/views/chain-list': { build: detail.chainList, ttl: 15, param: 'id' },
  '/views/block-list': { build: detail.blockList, ttl: 30, param: 'id' },
  '/views/pool-events': { build: detail.poolEvents, ttl: 15, param: 'id' },
  '/views/asset': { build: detail.asset, ttl: 60, param: 'id' },
  '/views/asset-list': { build: detail.assetList, ttl: 60, param: 'id' },
  '/views/amm-pools': { build: detail.ammPools, ttl: 30 },
  '/views/btc-address': { build: detail.btcAddress, ttl: 30, param: 'id' },
  '/views/btc-address-txs': { build: detail.btcAddressTxs, ttl: 3600, param: 'id' },
};

// One deadline per build, well inside the function's maxDuration: past it the cache answers with its stale copy
// (or a 504), and the build carries on in the background (later) and is stored when it ends, for the next request.
const VIEW_DEADLINE_MS = 8_000;
const keepAlive = (p) => { later(p); return p; };

// One build, traced: if any upstream answer it used was a fallback, the view says so (stale, staleSince) unless it
// already reports its own staleness in detail (selfStale: confidential's totals, checks' per-row status).
async function build(view, arg) {
  const { result, trace } = await traced(() => (arg ? asLookup(() => view.build(arg)) : view.build(arg)));
  if (!trace.stale || view.selfStale || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  return { ...result, stale: true, staleSince: trace.oldest };
}

// Cached per process so concurrent visitors share one build.
function getView(path, param) {
  if (!Object.hasOwn(VIEWS, path)) return null;
  const view = VIEWS[path];
  const arg = view.param ? String(param ?? '').trim().slice(0, 512) : undefined;
  // Incomplete results (an upstream was rate-limited) are kept only briefly, so the next visit retries.
  // The live cards (no parameter) answer from the last build for up to a minute past expiry while a new one is made.
  return (view.param ? lookupCache : cached)(`view:${path}:${arg ?? ''}`, () => keepAlive(build(view, arg)), { deadlineMs: VIEW_DEADLINE_MS, ttlMs: (d) => (d?.partial || d?.stale ? 5_000 : d?.gaps ? 15_000 : (Number(d?.cacheTtl) > 0 ? d.cacheTtl : view.ttl) * 1000), swrMs: view.param ? 0 : 60_000 });
}

// Decode the recent Bitcoin blocks in the background as soon as a server process starts, so the first visitor
// does not wait for ~40 raw blocks. Called by the dev server and the Vercel entry, not by tests.
// On instance start: build what the home page asks for first, so the first visitor after a cold start waits less.
function warm() {
  return Promise.all(['/views/btc-blocks', '/views/bridge-state', '/views/confidential', '/views/checks', '/views/envelopes', '/views/measured-privacy'].map((p) => getView(p).catch(() => {})));
}

module.exports = { VIEWS, getView, warm, unwrapN, slim, CHAINS };
