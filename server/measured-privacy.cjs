// Measured privacy: what is actually linkable on chain right now, as opposed to what the protocol can hide.
//
// ConfidentialPool: a spend is "traced" when its nullifier is keccak(leaf ‖ "spent") for a leaf anyone can see. SPEC
// §4.1 gives that formula for bearer and Bitcoin-homed notes; lock nullifiers follow it too (measured: 70 of 73 locks
// on 2026-11-12, not stated in SPEC). A lock is spent by a claim or a refund (the contract does not say which in the
// nullifier). Bridge mints add a Bitcoin burn's nullifier, published in its envelope (see bitcoinLinked). Owned notes use a secret key, so their spends cannot be traced. The full history
// is read from Ethereum, not from Tacit's API: a snapshot made by scripts/privacy-snapshot.mjs (pool logs and settle
// calldata since deploy) ships with the server, and catchUp() folds in the newer blocks.
//
// EVM pool: the last 24 hours of Transact events on each chain (deposits, withdrawals, private transfers), with each
// deposit's sender read from its transaction, so a withdrawal back to an address that deposited can be counted.
const fs = require('node:fs');
const path = require('node:path');
const { keccak256 } = require('./keccak.cjs');
const { fetchJson, getUpstream, spend, mapLimit } = require('./upstream.cjs');
const { rpc, rpcRaw, rpcArchive, RPCS } = require('./rpc.cjs');
const { decodePoolLogs, POOL: POOL_ADDRESS } = require('./pool-logs.cjs');
const { later } = require('./background.cjs');
const evmSnapshot = require('./evm-snapshot.cjs');
const { entriesFromLogs, txsNeedingInput, emptyCounts, addCounts } = require('./pool-index.cjs');
const { emptyChain, extend, grow } = require('./tacit-chain.cjs');

const DAY_BLOCKS = 7_200; // Ethereum blocks per day (12 s)
const PREFIX = 12; // hex chars kept per candidate nullifier: 48 bits, collisions negligible at this size

// ---- ConfidentialPool ----

const traceKey = (leaf) => keccak256(Buffer.concat([Buffer.from(String(leaf).replace(/^0x/, ''), 'hex'), Buffer.from('spent')])).toString('hex').slice(0, PREFIX);

function emptyState() {
  return { nextSeq: 0, headBlock: 0, candidates: new Map(), spends: 0, lockSpends: 0, traced: { lock: 0, bearer: 0 }, days: {}, latest: null, pairs: [], chain: emptyChain(), mints: [] };
}

// Fold index entries (in seq order) into the state. Exported for the snapshot script.
function fold(state, entries) {
  for (const e of entries) {
    for (const key of ['leaves', 'lockLeaves']) for (const leaf of e[key] || []) state.candidates.set(traceKey(leaf), { block: e.block, tx: e.tx, lock: key === 'lockLeaves' });
    for (const key of ['nullifiers', 'lockNullifiers']) {
      for (const n of e[key] || []) {
        const lock = key === 'lockNullifiers';
        state.spends++;
        if (lock) state.lockSpends++;
        const day = Math.floor(e.block / DAY_BLOCKS);
        const d = state.days[day] || (state.days[day] = [0, 0]);
        d[0]++;
        const made = state.candidates.get(String(n).replace(/^0x/, '').toLowerCase().slice(0, PREFIX));
        if (made) {
          state.traced[lock ? 'lock' : 'bearer']++;
          d[1]++;
          state.latest = { lock, made: made.tx, spent: e.tx, blocks: e.block - made.block };
          // Every traced pair, so the list behind the count can be shown (created tx may be null for leaves loaded
          // from the snapshot's compact candidates; the traced view looks those up).
          state.pairs.push({ lock, made: made.tx, madeBlock: made.block, spent: e.tx, spentBlock: e.block, ...(made.tx ? {} : { key: String(n).replace(/^0x/, '').toLowerCase().slice(0, PREFIX) }) });
        }
      }
    }
    state.headBlock = Math.max(state.headBlock, e.block || 0);
  }
  return state;
}

const SNAPSHOT = path.join(__dirname, 'data', 'privacy-snapshot.json');
function load() {
  try {
    const s = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    const state = { ...emptyState(), ...s, candidates: new Map() };
    for (let i = 0; i < s.candidates.length; i += PREFIX + 8) {
      // Each candidate: 12 hex of the trace key, then the creating block as 8 hex. The creating tx is not kept.
      const block = Number.parseInt(s.candidates.slice(i + PREFIX, i + PREFIX + 8), 16);
      state.candidates.set(s.candidates.slice(i, i + PREFIX), { block, tx: null, lock: false });
    }
    return state;
  } catch { return emptyState(); }
}
function serialize(state) {
  let candidates = '';
  for (const [k, v] of state.candidates) candidates += k + Math.max(0, v.block).toString(16).padStart(8, '0');
  const { candidates: _, ...rest } = state;
  return { ...rest, candidates };
}

let pool = null, lastRead = 0, reading = null;
// Blocks are folded into the state for good only once they are 12 deep. Since the Merge, Ethereum reorgs are almost
// always a single block, so 12 leaves a wide margin; the snapshot stops at the same depth. The newest 12 blocks are
// a "tail": re-read on every call and never folded, so the totals still reach the head and a reorg there is simply
// read again.
const CONFIRM = 12;
const PARALLEL = 6; // windows read at once while catching up
const SPAN = 5_000; // blocks per eth_getLogs (publicnode serves 10,000-block ranges, ~10,000 blocks deep)
const RECENT = 600; // folded blocks (~2 h) whose own counts are kept, so totals can be taken at a recent block
const hexBlock = (n) => `0x${n.toString(16)}`;

// The pool's logs from..to, the calldata of their settle transactions, and the entries and per-block counts built
// from them. Throws when any transaction could not be read (a window is used whole or not at all).
async function readWindow(from, to) {
  spend('eth_getLogs on chain 1', 40);
  const logs = await rpcRaw(1, 'eth_getLogs', [{ address: POOL_ADDRESS, fromBlock: hexBlock(from), toBlock: hexBlock(to) }]);
  const hashes = txsNeedingInput(logs);
  const txs = await Promise.all(hashes.map((h) => rpc(1, 'eth_getTransactionByHash', [h], { ttlMs: (x) => (x ? DAY : 10_000), store: 'chain' })));
  const counts = emptyCounts(), byBlock = new Map(), acc = {};
  const entries = entriesFromLogs(logs, new Map(hashes.map((h, i) => [h, txs[i]?.input])), counts, byBlock, acc);
  return { entries, counts, byBlock, bodies: acc.bodies || [], mints: (acc.mints || []).map((m) => [m.nullifier, m.tx, m.block]) };
}

// Fold in the pool's newer blocks straight from Ethereum (pool-index.cjs). At most once every 30 s per instance, and
// for up to 4 s per call; a fresh snapshot leaves only hours of blocks to read.
function catchUp() {
  pool ||= load();
  if (reading) return reading; // callers during a read wait for it, so none answers from the older state
  if (Date.now() - lastRead < 30_000) return Promise.resolve(pool);
  lastRead = Date.now();
  reading = readNewer().finally(() => { reading = null; });
  return reading;
}
async function readNewer() {
  try {
    const top = Number.parseInt(await rpc(1, 'eth_blockNumber', [], { ttlMs: 10_000 }), 16);
    const head = top - CONFIRM;
    pool.indexHead = head;
    pool.nextBlock ||= pool.headBlock + 1;
    pool.recent ||= [];
    pool.recentFrom ??= pool.nextBlock - 1; // counts at any block from here up can be rebuilt from `recent`
    // Up to PARALLEL windows are read at once and folded in block order, so days of blocks since the snapshot take
    // about one window's time instead of one per window. A window that failed stops the fold there (each window is
    // folded whole or not at all) and is read again on the next call.
    const deadline = Date.now() + 4_000;
    while (pool.nextBlock <= head && Date.now() < deadline) {
      const starts = [];
      for (let s = pool.nextBlock; s <= head && starts.length < PARALLEL; s += SPAN) starts.push(s);
      const got = await Promise.all(starts.map((s) => readWindow(s, Math.min(head, s + SPAN - 1)).catch(() => null)));
      let folded = 0;
      for (let i = 0; i < starts.length && got[i]; i++, folded++) {
        const w = got[i];
        fold(pool, w.entries);
        addCounts(pool.counts ||= emptyCounts(), w.counts);
        pool.chain = grow(pool.chain || emptyChain(), w.bodies);
        (pool.mints ||= []).push(...w.mints);
        for (const [block, c] of w.byBlock) pool.recent.push({ block, c });
        pool.nextBlock = Math.min(head, starts[i] + SPAN - 1) + 1;
      }
      if (!folded) break;
    }
    while (pool.recent.length && pool.recent[0].block <= pool.nextBlock - 1 - RECENT) pool.recentFrom = pool.recent.shift().block;
    pool.recentFrom = Math.max(pool.recentFrom, pool.nextBlock - 1 - RECENT);
    if (pool.nextBlock > head) {
      const t = await readWindow(pool.nextBlock, top);
      pool.tail = { from: pool.nextBlock, through: top, byBlock: t.byBlock, blocks: extend(pool.chain || emptyChain(), t.bodies).made, mints: t.mints };
    }
  } catch { /* read again on the next call; nothing half-folded */ }
  pool.synced = pool.indexHead != null && pool.nextBlock > pool.indexHead;
  return pool;
}

// The pool's totals as they stood at the end of `block`: the folded totals, minus recent folded blocks after it, plus
// tail blocks up to it. Null when this instance cannot say (the block is newer than it has read, or older than ~2 h).
function countsAt(state, block) {
  if (!state.counts) return null;
  const through = state.nextBlock - 1;
  const tail = state.tail && state.tail.from === state.nextBlock ? state.tail : null;
  if (block > (tail ? tail.through : through)) return null;
  const out = { ...state.counts };
  if (block >= through) { for (const [b, c] of tail?.byBlock || []) if (b <= block) addCounts(out, c); return out; }
  if (block < state.recentFrom) return null;
  for (const { block: b, c } of state.recent) if (b > block) addCounts(out, c, -1);
  return out;
}

// The pool's totals since deploy from this index, up to the newest block read (the ConfidentialPool card shows them).
async function poolCounts() {
  const state = await catchUp();
  const tail = state.tail && state.tail.from === state.nextBlock ? state.tail : null;
  const throughBlock = tail ? tail.through : state.nextBlock - 1;
  return { counts: countsAt(state, throughBlock), throughBlock, synced: Boolean(state.synced) };
}
// The Tacit chain, newest first, in the shape of Tacit's /prover/blocks: the folded blocks plus the tail's blocks that
// are at least 6 deep (as deep as Tacit's own index reads), so a short reorg cannot renumber a block shown here.
const CHAIN_DEPTH = 6;
async function chainBlocks({ limit = 30, before = null } = {}) {
  const state = await catchUp();
  const tail = state.tail && state.tail.from === state.nextBlock ? state.tail : null;
  const top = tail ? tail.through : state.nextBlock - 1 + CONFIRM;
  const all = [...(state.chain?.blocks || []), ...(tail?.blocks || []).filter((b) => b.ethBlock <= top - CHAIN_DEPTH)];
  const head = all.at(-1) || null;
  const below = before == null ? Infinity : Number(before);
  return {
    head: head ? { height: head.height, hash: head.hash, ethHead: top } : null,
    oldest: all[0]?.height ?? null,
    blocks: all.filter((b) => b.height < below).slice(-Math.max(1, Math.min(200, limit))).reverse(),
  };
}
// Burn nullifiers that bridge mints spent, since deploy (settle calldata), folded and tail.
async function bridgeMints() {
  const state = await catchUp();
  const tail = state.tail && state.tail.from === state.nextBlock ? state.tail : null;
  return [...(state.mints || []), ...(tail?.mints || [])];
}

// The same totals at a given block (the Verifier compares them with Tacit's index at the block Tacit has read to).
async function poolCountsAt(block) {
  const state = await catchUp();
  return { block, counts: countsAt(state, block), readTo: state.tail && state.tail.from === state.nextBlock ? state.tail.through : state.nextBlock - 1 };
}

// traced: matched to a pool leaf here. bitcoin: nullifiers published on Bitcoin (bridge mints, fast-lane spends).
// The rest have no public link from the nullifier (owned notes); they can still be linked by amount and timing at
// the pool boundary, which the EVM half of the card measures.
function poolSummary(state, linked) {
  const head = Math.floor((state.indexHead || state.headBlock) / DAY_BLOCKS);
  const days = Array.from({ length: 7 }, (_, i) => state.days[head - 6 + i] || [0, 0]);
  const traced = state.traced.lock + state.traced.bearer;
  const bitcoin = linked ? linked.mints + linked.fastLane : null;
  return {
    spends: state.spends, traced, bitcoin, bitcoinMints: linked?.mints ?? null, fastLane: linked?.fastLane ?? null, unlinked: bitcoin == null ? null : state.spends - traced - bitcoin,
    lockClaims: state.lockSpends, lockTraced: state.traced.lock, bearer: state.traced.bearer,
    days, latest: state.latest, synced: Boolean(state.synced), throughBlock: (state.nextBlock || state.headBlock + 1) - 1,
  };
}

// ---- EVM pool ----

const EVM_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
// Per chain: how many blocks one eth_getLogs may span on its first public RPC (publicnode Ethereum: 10,000 deep, so
// 2,000-block windows; Base publicnode: 50,000; Robinhood: no limit seen). Windows are aligned so older ones are
// kept and only the newest is read again.
const CHAINS = { 1: { name: 'Ethereum', span: 2_000 }, 8453: { name: 'Base', span: 50_000 }, 4663: { name: 'Robinhood', span: 1_000_000 } };
const DAY = 24 * 3600_000;
const senders = new Map(); // deposit tx hash -> sender, kept while the tx is in a window
const windows = new Map(); // "chain:start" -> { events, final, at }: decoded events only (raw Base windows are 1-2 MB)
const lastGood = new Map(); // chain -> last complete result, shown when a scan fails
const latest = new Map(); // chain -> newest events of its last scan, for the activity card
const catchingUp = new Set(); // chains whose deposit senders are being read in the background
const clocks = new Map(); // chain -> { head, headTime, secs } of its last scan
const tails = new Map(); // chain -> events after the EVM snapshot (evm-history.cjs), oldest first
const ethGap = { start: null, end: null, events: [] }; // Ethereum blocks between the snapshot and the live windows

// Seconds per block and the head's time, from two headers at a fixed reference (head rounded down to 1,000), so the
// same two cache entries serve every build until the reference moves.
async function blockTime(chain, head) {
  const ref = head - (head % 1_000), back = 100_000;
  const [a, b] = await Promise.all([ref, ref - back].map((n) => rpc(chain, 'eth_getBlockByNumber', [`0x${n.toString(16)}`, false], { ttlMs: DAY, store: 'chain' })));
  const secs = (Number.parseInt(a.timestamp, 16) - Number.parseInt(b.timestamp, 16)) / back;
  return { secs, headTime: Math.round(Number.parseInt(a.timestamp, 16) + (head - ref) * secs) };
}

function decode(l) {
  const w = l.data.slice(2).match(/.{64}/g) || [];
  let amount = BigInt(`0x${w[5] || '0'}`);
  if (amount >= 1n << 255n) amount -= 1n << 256n; // extAmount is int256: >0 deposit, <0 withdrawal, 0 transfer
  // Word 6 is the relayer: zero when the user's own wallet sent the transaction (its sender is then public).
  return { block: Number.parseInt(l.blockNumber, 16), tx: l.transactionHash, amount, recipient: `0x${(w[4] || '').slice(24)}`, relayed: /[1-9a-f]/.test((w[6] || '').slice(24)) };
}

// One aligned log window, decoded. Settled windows are kept for a day; the newest is read again after a minute.
async function logWindow(chain, start, head) {
  const key = `${chain}:${start}`, hit = windows.get(key), to = Math.min(start + CHAINS[chain].span - 1, head);
  if (hit && (hit.final ? Date.now() - hit.at < DAY : Date.now() - hit.at < 60_000)) return hit.events;
  spend(`eth_getLogs on chain ${chain}`, 40);
  const logs = await rpcRaw(chain, 'eth_getLogs', [{ address: EVM_POOL, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
  const events = logs.map(decode);
  windows.set(key, { events, final: to < head - 64, at: Date.now() });
  return events;
}

// Ethereum logs older than publicnode serves (~10,000 blocks back), from an archive endpoint (rpc.cjs ARCHIVE) in
// 20,000-block ranges.
async function archiveLogs(from, to) {
  const out = [];
  for (let a = from; a <= to; a += 20_000) {
    spend('archive logs', 20);
    out.push(...await rpcArchive(1, 'eth_getLogs', [{ address: EVM_POOL, fromBlock: `0x${a.toString(16)}`, toBlock: `0x${Math.min(a + 19_999, to).toString(16)}` }]));
  }
  return out;
}

// Ethereum events from `start` to `end`, extending what was read before (the end moves up as the live windows do).
async function ethGapEvents(start, end) {
  if (ethGap.start !== start) Object.assign(ethGap, { start, end: start - 1, events: [] });
  if (end > ethGap.end) {
    const logs = await archiveLogs(ethGap.end + 1, end);
    ethGap.events.push(...logs.map(decode));
    ethGap.end = end;
  }
  return ethGap.events.filter((e) => e.block <= end);
}

// Deposit senders (tx.from), newest first, at most SENDERS_PER_SCAN per scan so a cold instance spreads the work over
// several builds. 100 per JSON-RPC batch, each batch counted against a budget, each endpoint tried in turn.
const SENDERS_PER_SCAN = 300;
async function fillSenders(chain, hashes) {
  const missing = hashes.filter((h) => !senders.has(h)).slice(0, SENDERS_PER_SCAN);
  for (let i = 0; i < missing.length; i += 100) {
    spend('deposit senders', 30);
    // Each endpoint in turn, asked only for what the previous ones left: publicnode answers null for older
    // transactions (pruned index), which the next endpoint usually has.
    let left = missing.slice(i, i + 100), answered = false, last = null;
    for (const url of RPCS[chain]) {
      if (!left.length) break;
      try {
        const body = JSON.stringify(left.map((h, id) => ({ jsonrpc: '2.0', id, method: 'eth_getTransactionByHash', params: [h] })));
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(8_000) });
        if (!res.ok) throw new Error(`RPC ${chain} ${new URL(url).host} HTTP ${res.status}`);
        const answer = await res.json();
        if (!Array.isArray(answer)) throw new Error(`RPC ${chain} ${new URL(url).host}: no batch answer`);
        answered = true;
        for (const r of answer) if (r.result?.from) senders.set(r.result.hash, r.result.from.toLowerCase());
        left = left.filter((h) => !senders.has(h));
      } catch (error) { last = error; }
    }
    if (!answered) throw last || new Error(`RPC ${chain}: no batch answer`);
  }
}

// The ranges a visitor can pick. Longer ones are not offered: the free public RPCs keep only ~33 h of Ethereum
// logs, and a week of Base would mean reading ~25,000 deposit transactions.
const RANGES = { '1h': 3_600, '6h': 21_600, '24h': 86_400 };

function summarise(events) {
  const deposits = events.filter((e) => e.amount > 0n), withdrawals = events.filter((e) => e.amount < 0n);
  const known = deposits.filter((d) => senders.has(d.tx));
  const depositors = new Set(known.map((d) => senders.get(d.tx)));
  const counts = new Map();
  for (const w of withdrawals) counts.set(w.recipient, (counts.get(w.recipient) || 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  return {
    deposits: deposits.length, withdrawals: withdrawals.length, transfers: events.length - deposits.length - withdrawals.length,
    ethIn: deposits.reduce((a, d) => a + d.amount, 0n).toString(), ethOut: withdrawals.reduce((a, w) => a - w.amount, 0n).toString(),
    // Counted over the deposits whose sender has been read so far (sendersRead of deposits).
    toDepositor: withdrawals.filter((w) => depositors.has(w.recipient)).length, sendersRead: known.length,
    recipients: counts.size, top: ranked.slice(0, 3).map(([address, n]) => ({ address, n })),
  };
}

// One scan of the longest range per chain; the shorter ranges are cut from it.
async function evmChain(chain) {
  const { name, span } = CHAINS[chain];
  const head = Number.parseInt(await rpc(chain, 'eth_blockNumber', [], { ttlMs: 10_000 }), 16);
  const { secs, headTime } = await blockTime(chain, head);
  const startOf = (seconds) => Math.max(0, head - Math.round(seconds / secs));
  const from = startOf(RANGES['24h']);
  // Blocks after the EVM snapshot are read too, so the withdrawal check (evm-history.cjs) has no gap: through the
  // aligned windows on Base and Robinhood, through the archive endpoint on Ethereum (publicnode's logs end ~10,000 blocks back).
  const snapThrough = evmSnapshot.through(chain);
  const liveFrom = Math.floor(from / span) * span;
  const tailFrom = snapThrough == null ? from : Math.min(from, snapThrough + 1);
  const events = [];
  if (chain === 1 && tailFrom < liveFrom) events.push(...await ethGapEvents(tailFrom, liveFrom - 1));
  // Up to four windows in flight, folded back in block order.
  const starts = [];
  for (let w = chain === 1 ? liveFrom : Math.floor(tailFrom / span) * span; w <= head; w += span) starts.push(w);
  for (const part of await mapLimit(starts, 4, (w) => logWindow(chain, w, head))) { if (part.error) throw part.error; events.push(...part); }
  for (const k of windows.keys()) if (k.startsWith(`${chain}:`) && Number(k.split(':')[1]) + span < tailFrom) windows.delete(k);
  const inRange = events.filter((e) => e.block >= from);
  const tail = events.filter((e) => e.block >= tailFrom);
  clocks.set(chain, { head, headTime, secs });
  tails.set(chain, tail);
  // Last day's senders first (the Measurement card), then the older tail's (the withdrawal check).
  // Withdrawals a wallet sent itself need their sender too (the withdrawal check links by sender as well).
  const depositTxs = [...inRange, ...tail.filter((e) => e.block < from)].filter((e) => e.amount > 0n || (e.amount < 0n && !e.relayed)).map((d) => d.tx).reverse();
  await fillSenders(chain, depositTxs);
  // Keep reading the rest in the background (budgeted), so a cold instance catches up in minutes, not one batch of
  // 300 per page build.
  if (depositTxs.some((h) => !senders.has(h)) && !catchingUp.has(chain)) {
    catchingUp.add(chain);
    later((async () => {
      try { for (let i = 0; i < 20 && depositTxs.some((h) => !senders.has(h)); i++) await fillSenders(chain, depositTxs); } catch { /* budget or RPC: next scan resumes */ } finally { catchingUp.delete(chain); }
    })());
  }
  // Newest first, with a time estimated from the block number (exact enough for "3 min ago").
  latest.set(chain, inRange.slice(-20).reverse().map((e) => ({
    chain, name, tx: e.tx, block: e.block, time: Math.round(headTime - (head - e.block) * secs),
    kind: e.amount > 0n ? 'deposit' : e.amount < 0n ? 'withdrawal' : 'transfer',
    eth: (e.amount < 0n ? -e.amount : e.amount).toString(),
    address: e.amount > 0n ? senders.get(e.tx) || null : e.amount < 0n ? e.recipient : null,
  })));
  const result = { chain, name, ranges: Object.fromEntries(Object.entries(RANGES).map(([k, seconds]) => [k, summarise(inRange.filter((e) => e.block >= startOf(seconds)))])) };
  lastGood.set(chain, result);
  return result;
}

// A failed scan shows the chain's last good result (marked old) rather than an error; with none yet, the view is
// partial, so it is not cached and the page asks again shortly.
// One scan per chain at a time: Measurement and Activity share it instead of each reading the same windows.
const inFlight = new Map();
function scanOf(chain) {
  if (inFlight.has(chain)) return inFlight.get(chain);
  const p = evmChain(chain)
    .catch((e) => (lastGood.has(chain) ? { ...lastGood.get(chain), old: true } : { chain, name: CHAINS[chain].name, pending: true, error: String(e.message || e) }))
    .finally(() => inFlight.delete(chain));
  inFlight.set(chain, p);
  return p;
}

// Spends whose nullifier is published on Bitcoin: each bridge mint adds the burned note's ν (from its 161-byte burn
// envelope) to the pool's nullifiers (ConfidentialPool.sol settle step 6), and each fast-lane spend of a
// Bitcoin-homed note consumes a note whose ν is derivable from Bitcoin data. Counts from /reflection/status.
// The counts only grow, so a failed read keeps the last good one (a day of stale fallback, then this instance's
// memory); with neither, the card says the count is unavailable instead of folding it into "no public link".
let lastLinked = null;
// Bridge mints come from this site's own pool index (settle calldata); the fast-lane count is still Tacit's.
async function bitcoinLinked() {
  const [status, mints] = await Promise.all([
    getUpstream('/reflection/status', '', { ttlMs: 15_000, staleMs: 24 * 3600_000 }).then((r) => r.data).catch(() => null),
    bridgeMints().catch(() => null),
  ]);
  if (mints || status) lastLinked = { mints: mints ? mints.length : Number(status.bridgeMinted) || 0, fastLane: status ? Number(status.consumedCount) || 0 : lastLinked?.fastLane ?? 0 };
  return lastLinked;
}

// A chain's first scan (a day of Base logs) can take ~20 s. Answer with what is ready after 6 s; the rest keeps
// running in the background (later) into the caches, and the page refills.
const READY_MS = 6_000;
async function measuredPrivacy() {
  const ids = Object.keys(CHAINS).map(Number);
  const scans = ids.map(scanOf);
  scans.forEach((p) => later(p));
  const wait = new Promise((resolve) => setTimeout(resolve, READY_MS).unref?.()); // a deadline never keeps the process alive
  const [state, linked, ...chains] = await Promise.all([catchUp(), bitcoinLinked(), ...scans.map((p, i) => Promise.race([p, wait.then(() => lastGood.get(ids[i]) || { chain: ids[i], name: CHAINS[ids[i]].name, pending: true })]))]);
  if (senders.size > 200_000) senders.clear();
  return {
    view: 'measured-privacy', sources: ['ConfidentialPool logs and settle calldata since deploy (server/data/privacy-snapshot.json, then eth_getLogs)', '/reflection/status (bridge mints, fast-lane spends)', 'eth_getLogs Transact on the EVM pool (Ethereum, Base, Robinhood)', 'eth_getTransactionByHash (deposit senders)'],
    pool: poolSummary(state, linked), evm: chains, partial: chains.some((c) => c.pending) || undefined,
  };
}

// The newest EVM pool events across chains, from the same scans (started here if this instance has none yet).
// A cold instance's first answer: each chain's newest blocks only (one eth_getLogs and a few senders), instead of
// waiting for the day-long scan behind the Measurement card. The full scan replaces it when done.
const QUICK = { 1: 9_000, 8453: 49_000, 4663: 1_000_000 }; // blocks: ~30 h, ~2.7 h, ~1 day: each one read on its RPC
async function quickLatest(chain) {
  const head = Number.parseInt(await rpc(chain, 'eth_blockNumber', [], { ttlMs: 10_000 }), 16);
  const { secs, headTime } = await blockTime(chain, head);
  const logs = await rpcRaw(chain, 'eth_getLogs', [{ address: EVM_POOL, fromBlock: `0x${Math.max(0, head - QUICK[chain]).toString(16)}`, toBlock: `0x${head.toString(16)}` }]);
  const events = logs.map(decode).slice(-10);
  await fillSenders(chain, events.filter((e) => e.amount > 0n).map((e) => e.tx)).catch(() => {});
  if (latest.has(chain) || !events.length) return; // the full scan finished first, or nothing that recent
  latest.set(chain, events.reverse().map((e) => ({
    chain, name: CHAINS[chain].name, tx: e.tx, block: e.block, time: Math.round(headTime - (head - e.block) * secs),
    kind: e.amount > 0n ? 'deposit' : e.amount < 0n ? 'withdrawal' : 'transfer', eth: (e.amount < 0n ? -e.amount : e.amount).toString(),
    address: e.amount > 0n ? senders.get(e.tx) || null : e.amount < 0n ? e.recipient : null,
  })));
}

async function evmActivity() {
  // Rescan on every build (30 s view cache): older log windows are cached for a day, so only the newest window and
  // new deposit senders are read. A cold instance answers from each chain's newest blocks (quickLatest) within a
  // second or two; a warm one waits at most 3 s for the rescan.
  const ids = Object.keys(CHAINS).map(Number);
  const scans = ids.map(scanOf);
  scans.forEach((p) => later(p));
  const quick = ids.filter((c) => !latest.has(c)).map((c) => quickLatest(c).catch(() => {}));
  await Promise.race([Promise.all(scans), quick.length ? Promise.all(quick) : new Promise((resolve) => setTimeout(resolve, 3_000))]);
  const rows = [...latest.values()].flat().sort((a, b) => b.time - a.time).slice(0, 10);
  return { view: 'evm-activity', sources: ['eth_getLogs Transact on the EVM pool (Ethereum, Base, Robinhood)', 'eth_getTransactionByHash (deposit senders)'], rows, partial: latest.size < Object.keys(CHAINS).length || undefined };
}

// Every traced spend, newest first: the list behind the count. A pair matched against a compact snapshot entry has no
// creating transaction; it is found once from the pool's leaf logs at that block (a few per build).
const LEAF_TOPICS = ['0x7783fb256f5b4e1d4d8b79583488756286326ae15d9997d4098ce5432ed2708b', '0x18df91ea83f965ece7a17fbab444175c3b2fd487524b95576215d8113d0b8662'];
async function tracedList() {
  const state = await catchUp();
  const missing = state.pairs.filter((p) => !p.made && p.key).slice(-8);
  for (const p of missing) {
    try {
      const logs = await rpc(1, 'eth_getLogs', [{ address: POOL_ADDRESS, topics: [LEAF_TOPICS], fromBlock: `0x${p.madeBlock.toString(16)}`, toBlock: `0x${p.madeBlock.toString(16)}` }], { ttlMs: DAY, store: 'chain' });
      for (const e of decodePoolLogs({ logs })) {
        for (const leaf of [...(e.leaves || []), ...(e.lockLeaves || [])]) {
          if (traceKey(leaf) === p.key) p.made = logs.find((l) => Number.parseInt(l.logIndex, 16) === e.logIndex)?.transactionHash || null;
        }
      }
    } catch { /* tried again on the next build */ }
  }
  return {
    view: 'traced', sources: ['ConfidentialPool logs and settle calldata since deploy', 'eth_getLogs (leaf logs, for pairs from the snapshot)'],
    total: state.pairs.length, pairs: [...state.pairs].reverse().map(({ key, ...p }) => p),
  };
}

// For evm-history.cjs on a cold instance: each chain's clock alone (two cached headers), so the snapshot can be
// served before the first scan ends.
async function evmClocks() {
  return Promise.all(Object.keys(CHAINS).map(Number).map(async (chain) => {
    if (clocks.has(chain)) return { chain, clock: clocks.get(chain), events: null };
    try {
      const head = Number.parseInt(await rpc(chain, 'eth_blockNumber', [], { ttlMs: 10_000 }), 16);
      return { chain, clock: { head, ...(await blockTime(chain, head)) }, events: null };
    } catch { return { chain, clock: null, events: null }; }
  }));
}

// For evm-history.cjs: start the scans and wait up to `ms` for them; then each chain's events after the snapshot
// (with deposit senders where read) and its clock.
async function evmTails(ms = READY_MS) {
  const scans = Object.keys(CHAINS).map((c) => scanOf(Number(c)));
  scans.forEach((p) => later(p));
  await Promise.race([Promise.all(scans), new Promise((resolve) => setTimeout(resolve, ms))]);
  return Object.keys(CHAINS).map(Number).map((chain) => ({
    chain, clock: clocks.get(chain) || null,
    events: tails.has(chain) ? tails.get(chain).map((e) => ({ block: e.block, tx: e.tx, amount: e.amount, addr: e.amount > 0n ? senders.get(e.tx) || null : e.amount < 0n ? e.recipient.toLowerCase() : null, relayed: e.relayed, by: e.amount < 0n && !e.relayed ? senders.get(e.tx) || null : null })) : null,
  }));
}

module.exports = { load, countsAt, poolCounts, chainBlocks, bridgeMints, poolCountsAt, tracedList, evmActivity, measuredPrivacy, evmTails, evmClocks, fold, emptyState, serialize, traceKey, EVM_POOL, decode };
