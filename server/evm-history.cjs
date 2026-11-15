// Withdrawal check: can an EVM pool withdrawal be tied to a deposit in plain sight? The pool hides which deposit pays
// which withdrawal, but two public facts can give it away (Tacit docs/EVM-POOL.md, "What each action shows"):
//   by recipient: the withdrawal pays an address that deposited before it;
//   by sender: no relayer was used, so the wallet that sent the withdrawal is public, and that wallet deposited before.
// History: the EVM snapshot (evm-snapshot.cjs) plus the blocks after it from the live scan (measured-privacy.cjs).
// Addresses are counted, not withdrawals: one Base address round-trips thousands of times a day, and counting its
// withdrawals would make the whole pool look linked.
const evmSnapshot = require('./evm-snapshot.cjs');
const { evmTails, evmClocks, EVM_POOL, decode } = require('./measured-privacy.cjs');
const { rpc } = require('./rpc.cjs');
const { later } = require('./background.cjs');

const CHAINS = { 1: 'Ethereum', 8453: 'Base', 4663: 'Robinhood' };
const PAIRS = 5; // linked pairs shown per lookup
const HEAVY = 1_000; // an address with this many linked withdrawals is a repeated loop, counted apart in the summary
let built = null; // { at, index }

// Seconds since 1970 for a block, from the chain's clock (exact enough to order deposits and withdrawals across chains).
// Seconds since 1970 for a block. Inside the snapshot: interpolated between its block-time anchors (real header times;
// block speed changed over time, so today's speed stretched back would misdate old blocks by weeks on Base). After it:
// from the live clock, or from the last two anchors while that chain's clock is not read yet.
function dater(clock, anchors) {
  const a = anchors?.length > 1 ? anchors : null;
  return (block) => {
    if (a && block <= a.at(-1)[0]) {
      let lo = 0, hi = a.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m][0] <= block) lo = m; else hi = m; }
      const [b0, t0] = a[lo], [b1, t1] = a[hi];
      return Math.round(b1 === b0 ? t0 : t0 + ((block - b0) * (t1 - t0)) / (b1 - b0));
    }
    if (clock) return Math.round(clock.headTime - (clock.head - block) * clock.secs);
    if (a) { const [b0, t0] = a.at(-2), [b1, t1] = a.at(-1); return Math.round(t1 + ((block - b1) * (t1 - t0)) / (b1 - b0)); }
    return null;
  };
}

function buildIndex(tails, snap = evmSnapshot.load()) {
  const byAddr = new Map(); // address -> { deps, wds (paid to it), sent (withdrawals it sent to another address) }
  const entry = (a) => { if (!byAddr.has(a)) byAddr.set(a, { deps: [], wds: [], sent: [] }); return byAddr.get(a); };
  const amounts = new Map(); // "chain:amount" -> deposit blocks, ascending
  const withdrawals = [];
  const clocks = {};
  const coverage = [];
  const totals = {}; // chain -> deposit and withdrawal counts and sums since deploy, and the newest event (EVM pool card)
  let missingSenders = 0;
  for (const { chain, clock, events } of tails) {
    const s = snap?.chains[chain];
    const timeOf = dater(clock, s?.anchors);
    clocks[chain] = timeOf;
    const t = totals[chain] = { deposits: 0, withdrawals: 0, depositWei: 0n, withdrawalWei: 0n, lastBlock: 0 };
    const count = (kind, e) => { t[kind] += 1; t[`${kind === 'deposits' ? 'deposit' : 'withdrawal'}Wei`] += BigInt(e.amount); if (e.block > t.lastBlock) t.lastBlock = e.block; };
    const dep = (e) => {
      count('deposits', e);
      const k = `${chain}:${e.amount}`;
      if (!amounts.has(k)) amounts.set(k, []);
      amounts.get(k).push(e.block);
      if (!e.addr) { missingSenders += 1; return; }
      entry(e.addr).deps.push({ chain, block: e.block, time: timeOf(e.block), amount: String(e.amount), tx: e.tx || null });
    };
    const wd = (e) => {
      count('withdrawals', e);
      if (!e.relayed && e.by === null && e.tx) missingSenders += 1; // live row whose sender is not read yet
      const w = { chain, block: e.block, time: timeOf(e.block), amount: String(e.amount), tx: e.tx || null, to: e.addr, by: e.relayed ? null : e.by || null, relayed: Boolean(e.relayed) };
      withdrawals.push(w);
      entry(w.to).wds.push(w);
      if (w.by && w.by !== w.to) entry(w.by).sent.push(w);
    };
    for (const d of s?.deposits || []) dep(d);
    for (const w of s?.withdrawals || []) wd(w);
    for (const e of events || []) {
      if (s && e.block <= s.through) continue; // the live scan's day overlaps the snapshot
      if (e.amount > 0n) dep(e);
      else if (e.amount < 0n) wd({ ...e, amount: -e.amount });
    }
    t.lastTime = t.lastBlock ? timeOf(t.lastBlock) : null;
    coverage.push({ chain, name: CHAINS[chain], from: s ? 'deploy' : 'last 24 h', through: events ? clock?.head ?? null : s?.through ?? null, live: Boolean(events), dated: timeOf(s?.through ?? clock?.head ?? 0) != null });
  }
  // The first deposit of each address; a withdrawal after it, paid to it or sent by it, is linked.
  const first = new Map();
  for (const [a, e] of byAddr) { e.deps.sort((x, y) => x.time - y.time); if (e.deps.length) first.set(a, e.deps[0].time); }
  const before = (a, t) => a != null && first.has(a) && first.get(a) < t;
  let linked = 0, byRecipient = 0, bySender = 0, relayed = 0;
  for (const w of withdrawals) {
    w.linkedBy = before(w.to, w.time) ? 'recipient' : w.by && w.by !== w.to && before(w.by, w.time) ? 'sender' : null;
    if (w.linkedBy) linked += 1;
    if (w.linkedBy === 'recipient') byRecipient += 1;
    if (w.linkedBy === 'sender') bySender += 1;
    if (w.relayed) relayed += 1;
  }
  let withdrew = 0, linkedAddrs = 0, heavy = 0, heavyLinked = 0;
  for (const e of byAddr.values()) {
    e.wds.sort((x, y) => x.time - y.time);
    if (!e.wds.length) continue;
    withdrew += 1;
    const n = e.wds.filter((w) => w.linkedBy).length;
    if (n) linkedAddrs += 1;
    if (n >= HEAVY) { heavy += 1; heavyLinked += n; }
  }
  for (const list of amounts.values()) list.sort((a, b) => a - b);
  // The most used deposit amounts per chain: the crowds a withdrawal can hide in.
  const common = {};
  for (const [k, list] of amounts) {
    const [chain, amount] = k.split(':');
    (common[chain] ||= []).push({ amount, deposits: list.length });
  }
  for (const c of Object.keys(common)) common[c] = common[c].sort((a, b) => b.deposits - a.deposits).slice(0, 3);
  return {
    // Until every chain has its live blocks (or with no way to date a chain), a missing link is not yet a finding.
    cold: coverage.some((c) => !c.live || !c.dated),
    byAddr, amounts, clocks, coverage, missingSenders, common, first, totals,
    summary: { withdrew, linked: linkedAddrs, fresh: withdrew - linkedAddrs, withdrawals: withdrawals.length, linkedWithdrawals: linked, byRecipient, bySender, relayed, heavy, heavyLinked, heavyAt: HEAVY, since: snap ? 'deploy' : null },
  };
}

// The index answers at once: only a cold instance waits for the live scans (up to 6 s); after that a stale index is
// served while a fresh one is built in the background from whatever the scans have.
let refreshing = null;
function refresh(wait) {
  refreshing ||= evmTails(wait).then((tails) => { built = { at: Date.now(), index: buildIndex(tails) }; return built.index; }).finally(() => { refreshing = null; });
  return refreshing;
}
// Cold: the snapshot alone, with each chain's clock (well under a second), while the scans run. Links found are certain;
// "no link" waits for the blocks after the snapshot (the verdict says "Still reading").
let cold = null;
async function index() {
  if (!built) {
    later(refresh(undefined));
    cold ||= evmClocks().then((tails) => buildIndex(tails)); // no live events yet, so it is cold by construction
    const first = await Promise.race([cold, refreshing]);
    return built?.index || first;
  }
  // An index still missing a chain's live blocks or some senders is rebuilt every few seconds, a complete one each minute.
  if (Date.now() - built.at > (built.index.cold || built.index.missingSenders ? 3_000 : 60_000)) later(refresh(0));
  return built.index;
}

// Deposits before `block` with exactly this amount, on that chain (binary search).
function crowd(idx, chain, amount, block) {
  const list = idx.amounts.get(`${chain}:${amount}`) || [];
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m] < block) lo = m + 1; else hi = m; }
  return lo;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// The deposit that gives a linked withdrawal away: the newest one before it from the address that links it.
// deps are sorted by time, so a binary search finds it (an address can have tens of thousands).
function pairOf(idx, w) {
  const who = w.linkedBy === 'recipient' ? w.to : w.by;
  const deps = idx.byAddr.get(who)?.deps || [];
  let lo = 0, hi = deps.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (deps[m].time < w.time) lo = m + 1; else hi = m; }
  return { by: w.linkedBy, wallet: who, dep: deps[lo - 1] || null, wd: w };
}

// Verdict for a set of withdrawals: all linked, some, none (or not known yet while senders load).
function ladder(idx, list, deposits) {
  const n = list.filter((w) => w.linkedBy).length;
  if (list.length && n === list.length) return 'full';
  if (n) return 'partial';
  if (list.length) return idx.missingSenders || idx.cold ? 'pending' : 'nolink';
  if (deposits) return 'deposits';
  return idx.missingSenders || idx.cold ? 'pending' : 'none';
}

function addressReport(idx, address) {
  const e = idx.byAddr.get(address);
  if (!e) return { address, verdict: idx.missingSenders || idx.cold ? 'pending' : 'none', deposits: 0, withdrawals: 0, sent: 0, linked: 0 };
  // Its withdrawals: the ones paid to it, and the ones its wallet sent to other addresses.
  const mine = [...e.wds, ...e.sent].sort((a, b) => a.time - b.time);
  const linked = mine.filter((w) => w.linkedBy);
  const pairs = linked.map((w) => pairOf(idx, w));
  const sum = (list) => list.reduce((a, x) => a + BigInt(x.amount), 0n).toString();
  return {
    address,
    verdict: ladder(idx, mine, e.deps.length),
    deposits: e.deps.length, withdrawals: e.wds.length, sent: e.sent.length, linked: linked.length,
    byRecipient: linked.filter((w) => w.linkedBy === 'recipient').length, bySender: linked.filter((w) => w.linkedBy === 'sender').length,
    selfSent: mine.filter((w) => !w.relayed).length,
    depositedWei: sum(e.deps), withdrawnWei: sum(e.wds),
    chains: [...new Set([...e.deps, ...mine].map((x) => CHAINS[x.chain]))],
    typicalGap: median(pairs.filter((p) => p.dep).map((p) => p.wd.time - p.dep.time)),
    pairs: pairs.slice(-PAIRS).reverse(),
  };
}

// A transaction: the pool's Transact log in its receipt (whichever chain has it), judged on its own, plus the report
// for the address it names.
async function txReport(idx, hash) {
  for (const chain of Object.keys(CHAINS).map(Number)) {
    const receipt = await rpc(chain, 'eth_getTransactionReceipt', [hash], { ttlMs: 300_000 }).catch(() => null);
    if (!receipt) continue;
    const log = (receipt.logs || []).find((l) => l.address?.toLowerCase() === EVM_POOL.toLowerCase() && (l.data || '').length >= 2 + 64 * 6);
    if (!log) return { tx: { hash, chain, name: CHAINS[chain], kind: null } };
    const ev = decode(log);
    const kind = ev.amount > 0n ? 'deposit' : ev.amount < 0n ? 'withdrawal' : 'transfer';
    const amount = (ev.amount < 0n ? -ev.amount : ev.amount).toString();
    const sender = String(receipt.from).toLowerCase();
    const address = kind === 'deposit' ? sender : kind === 'withdrawal' ? ev.recipient.toLowerCase() : null;
    const tx = { hash, chain, name: CHAINS[chain], kind, amount, block: ev.block, address };
    if (kind === 'withdrawal') {
      const time = idx.clocks[chain]?.(ev.block) ?? Infinity;
      const by = ev.relayed ? null : sender;
      const before = (a) => a && idx.first.has(a) && idx.first.get(a) < time;
      tx.relayed = ev.relayed;
      tx.sender = by;
      tx.linkedBy = before(address) ? 'recipient' : by && by !== address && before(by) ? 'sender' : null;
      tx.sameAmountBefore = crowd(idx, chain, amount, ev.block);
      tx.verdict = tx.linkedBy ? 'linked' : idx.missingSenders || idx.cold ? 'pending' : 'nolink';
      if (tx.linkedBy) tx.pair = pairOf(idx, { chain, block: ev.block, time, amount, tx: hash, to: address, by, relayed: ev.relayed, linkedBy: tx.linkedBy });
    }
    return { tx, ...(address ? addressReport(idx, address) : { verdict: 'none' }) };
  }
  return { tx: { hash, kind: null }, verdict: 'unknown' };
}

async function withdrawalCheck(q) {
  const idx = await index();
  const base = { view: 'withdrawal-check', sources: ['server/data/evm-snapshot.json.gz (EVM pool Transact logs since deploy, deposit and withdrawal senders)', 'eth_getLogs since the snapshot (publicnode; an archive node for older Ethereum blocks)', 'eth_getTransactionReceipt (looked-up transactions)'], summary: idx.summary, common: idx.common, coverage: idx.coverage, missingSenders: idx.missingSenders || undefined, partial: idx.cold || idx.missingSenders > 0 || undefined, reading: idx.coverage.filter((c) => !c.live).map((c) => ({ name: c.name, after: c.through })) };
  const query = String(q || '').trim().toLowerCase();
  if (!query) return base;
  if (/^0x[0-9a-f]{40}$/.test(query)) return { ...base, query, result: addressReport(idx, query) };
  if (/^0x[0-9a-f]{64}$/.test(query)) return { ...base, query, result: await txReport(idx, query) };
  return { ...base, query, result: { verdict: 'invalid' } };
}

// EVM pool totals per chain since deploy, from the same history as the withdrawal check (no Tacit API): counts and
// sums of deposits and withdrawals, and the newest event. `live` is false for a chain whose newest blocks are not read
// yet (its totals stop at the snapshot).
async function poolTotals() {
  const idx = await index();
  return Object.entries(idx.totals).map(([chain, t]) => {
    const c = idx.coverage.find((x) => String(x.chain) === chain);
    return { chain: Number(chain), name: CHAINS[chain], deposits: t.deposits, withdrawals: t.withdrawals, depositWei: t.depositWei.toString(), withdrawalWei: t.withdrawalWei.toString(), lastBlock: t.lastBlock || null, lastTime: t.lastTime ?? null, through: c?.through ?? null, live: Boolean(c?.live) };
  });
}

module.exports = { withdrawalCheck, buildIndex, addressReport, crowd, poolTotals };
