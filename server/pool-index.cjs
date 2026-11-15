// The ConfidentialPool's history read from Ethereum itself: the same records Tacit's /confidential/index serves.
// Note leaves, note nullifiers and lock leaves are pool logs. Lock nullifiers (lock claims and refunds) emit no
// event: they are read from each settle call's publicValues in the transaction's calldata, and only for calls the
// logs show ran (chain-verify.cjs, the same rule Tacit's index uses).
const { decodePoolLogs, POOL, NULLIFIERS, LEAVES } = require('./pool-logs.cjs');
const { lockNullifiersFrom, burnNullifiersFrom } = require('./chain-verify.cjs');

// Totals kept next to the privacy state, so the site can show (and check) them without Tacit's index.
const emptyCounts = () => ({ leaves: 0, nullifiers: 0, wraps: 0, crossOuts: 0, lockLeaves: 0, lockNullifiers: 0 });

// `logs`: raw pool log rows (eth_getLogs, any order). `inputs`: Map of lowercased tx hash -> calldata,
// needed for every transaction in `logs`. Returns the entries for measured-privacy's fold(), in chain order, and
// adds to `counts` when given; `byBlock` (a Map) also gets each block's own counts, so totals can be taken at any block.
// `chain` (an object), when given, collects `bodies`: one Tacit chain block body per transaction that changed notes
// (worker/src/tacit-chain.js in Tacit's repository: note leaves then lock leaves, note nullifiers then lock nullifiers,
// a wrap-only transaction is no block), and `mints`: the burn nullifiers that bridge mints spent.
function entriesFromLogs(logs, inputs, counts, byBlock, chain) {
  const byTx = new Map();
  for (const l of logs) {
    if (String(l.address).toLowerCase() !== POOL) continue;
    const tx = String(l.transactionHash).toLowerCase();
    if (!byTx.has(tx)) byTx.set(tx, []);
    byTx.get(tx).push(l);
  }
  const out = [];
  for (const [tx, rows] of byTx) {
    const block = Number.parseInt(rows[0].blockNumber, 16);
    const events = decodePoolLogs({ logs: rows }).sort((a, b) => a.logIndex - b.logIndex);
    const sinks = [counts, byBlock && (byBlock.get(block) || byBlock.set(block, emptyCounts()).get(block))].filter(Boolean);
    const seen = new Set();
    const body = { ethBlock: block, tx, firstLog: events[0]?.logIndex ?? 0, noteLeaves: [], lockLeaves: [], noteNfs: [], lockNfs: [], deposits: 0 };
    for (const e of events) {
      if (e.type === 'leaves') body.noteLeaves.push(...e.leaves);
      if (e.type === 'nullifiers') body.noteNfs.push(...e.nullifiers);
      if (e.type === 'lockLeaves') body.lockLeaves.push(...e.lockLeaves);
      if (e.type === 'wrap') body.deposits += 1;
      if (e.type === 'leaves') { out.push({ block, tx, logIndex: e.logIndex, leaves: e.leaves }); for (const x of e.leaves) seen.add(x.toLowerCase()); }
      if (e.type === 'nullifiers') { out.push({ block, tx, logIndex: e.logIndex, nullifiers: e.nullifiers }); for (const x of e.nullifiers) seen.add(x.toLowerCase()); }
      if (e.type === 'lockLeaves') out.push({ block, tx, logIndex: e.logIndex, lockLeaves: e.lockLeaves });
      for (const c of sinks) {
        if (e.type === 'leaves') c.leaves += e.leaves.length;
        if (e.type === 'nullifiers') c.nullifiers += e.nullifiers.length;
        if (e.type === 'lockLeaves') c.lockLeaves += e.lockLeaves.length;
        if (e.type === 'wrap') c.wraps += 1;
        if (e.type === 'crossOut') c.crossOuts += 1;
      }
    }
    if (seen.size) { // a note leaf or nullifier: a settle call ran, so it may also spend locks or mint bridge burns
      const input = inputs.get(tx);
      if (typeof input !== 'string') throw new Error(`calldata missing for ${tx}`); // must not read as "no lock spends"
      const lockNullifiers = lockNullifiersFrom(input, seen);
      if (lockNullifiers.length) {
        out.push({ block, tx, logIndex: events.at(-1).logIndex + 0.5, lockNullifiers });
        for (const c of sinks) c.lockNullifiers += lockNullifiers.length;
        body.lockNfs = lockNullifiers;
      }
      if (chain) for (const nu of burnNullifiersFrom(input, seen)) (chain.mints ||= []).push({ nullifier: nu.replace(/^0x/, '').toLowerCase(), tx, block });
    }
    if (chain && (body.noteLeaves.length || body.noteNfs.length || body.lockLeaves.length || body.lockNfs.length)) {
      (chain.bodies ||= []).push({ ethBlock: block, tx, firstLog: body.firstLog, leaves: [...body.noteLeaves, ...body.lockLeaves], nullifiers: [...body.noteNfs, ...body.lockNfs], notes: body.noteLeaves.length, spent: body.noteNfs.length, deposits: body.deposits });
    }
  }
  chain?.bodies?.sort((a, b) => a.ethBlock - b.ethBlock || a.firstLog - b.firstLog);
  return out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

// Transactions whose calldata entriesFromLogs needs (those with a note leaf or nullifier log).
function txsNeedingInput(logs) {
  const set = new Set();
  for (const e of logs) {
    const t = String(e.topics?.[0] || '').toLowerCase();
    if (String(e.address).toLowerCase() === POOL && (t === LEAVES || t === NULLIFIERS)) set.add(String(e.transactionHash).toLowerCase());
  }
  return [...set];
}

// Add (sign 1) or remove (sign -1) one counts object into another.
function addCounts(into, c, sign = 1) { for (const k of Object.keys(c)) into[k] = (into[k] || 0) + sign * c[k]; return into; }

module.exports = { entriesFromLogs, txsNeedingInput, emptyCounts, addCounts };
