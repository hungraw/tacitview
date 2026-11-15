// Verify a Tacit chain block from the chain itself (worker/src/tacit-chain.js, docs/TACIT-CHAIN.md):
//   hash = keccak256(prev ‖ uint64 height ‖ uint64 ethBlock ‖ tx ‖ keccak256(leaves…) ‖ keccak256(nullifiers…))
// leaves = note leaves then lock leaves, nullifiers = note nullifiers then lock nullifiers, all in log order.
// Leaves and note nullifiers come from the anchoring transaction's ConfidentialPool logs. Lock nullifiers emit no
// event: they are field 18 of each settle call's publicValues in the transaction's calldata (as Tacit's own index
// reads them, worker/src/confidential-index.js), counted only for calls whose note leaves / nullifiers the logs
// show actually ran. Everything comes from Ethereum; nothing from Tacit's API. Returns 'verified', 'mismatch' or
// 'unverifiable'.
const { keccak256 } = require('./keccak.cjs');
const { rpc } = require('./rpc.cjs');
const { cached } = require('./upstream.cjs');
const { decodePoolLogs } = require('./pool-logs.cjs');

const b32 = (h) => Buffer.from(String(h).replace(/^0x/, '').padStart(64, '0'), 'hex');
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const listHash = (xs) => keccak256(Buffer.concat(xs.map(b32)));

function blockHash({ prev, height, ethBlock, tx, leaves, nullifiers }) {
  return `0x${keccak256(Buffer.concat([b32(prev), u64(height), u64(ethBlock), b32(tx), listHash(leaves), listHash(nullifiers)])).toString('hex')}`;
}

// ---- settle calldata (ABI layout of ConfidentialPool.settle(bytes publicValues, bytes proof, bytes[] memos)) ----
const SEL = { settle: '717fd7f2', settleWithTip: '70b16a7d', relaySettle: 'fcccb833', relaySettleSeeded: 'e2b28725' };
const wordAt = (hex, byte) => BigInt(`0x${(hex.slice(byte * 2, byte * 2 + 64) || '').padEnd(64, '0')}`);
const bytesAt = (hex, byte) => { const len = Number(wordAt(hex, byte)); return hex.slice((byte + 32) * 2, (byte + 32 + len) * 2); };
const pvOf = (args) => bytesAt(args, Number(wordAt(args, 0))); // first head word: offset of publicValues
function settleCalls(input) {
  const raw = String(input || '').replace(/^0x/, '').toLowerCase();
  const sel = raw.slice(0, 8), args = raw.slice(8);
  if (sel === SEL.settle || sel === SEL.settleWithTip) return [pvOf(args)];
  if (sel === SEL.relaySettle || sel === SEL.relaySettleSeeded) { // (SettleCall[] calls[, seed]): each call a (bytes, bytes, bytes[]) tuple
    const arr = Number(wordAt(args, sel === SEL.relaySettle ? 0 : 32)), n = Number(wordAt(args, arr));
    return Array.from({ length: n }, (_, i) => pvOf(args.slice((arr + 32 + Number(wordAt(args, arr + 32 + i * 32))) * 2)));
  }
  const out = []; // a settle nested in another contract's calldata
  for (let i = raw.indexOf(SEL.settle, 8); i >= 0; i = raw.indexOf(SEL.settle, i + 1)) if (i % 2 === 0) { try { out.push(pvOf(raw.slice(i + 8))); } catch { /* not a call */ } }
  return out;
}
// publicValues opens with an offset to its struct; fields are arrays of bytes32: 3 nullifiers, 4 leaves, 18 lockNullifiers.
function pvArrays(pv) {
  const data = pv.slice(Number(wordAt(pv, 0)) * 2);
  const arr = (field) => { const off = Number(wordAt(data, field * 32)), n = Number(wordAt(data, off)); if (n > 4096 || (off + 32 + n * 32) * 2 > data.length) throw new Error('bad publicValues'); return Array.from({ length: n }, (_, i) => `0x${wordAt(data, off + 32 + i * 32).toString(16).padStart(64, '0')}`); };
  return { nullifiers: arr(3), leaves: arr(4), burns: arr(8), lockNullifiers: arr(18) };
}
// Lock nullifiers of the settle calls in `input` that ran: a call counts when one of its note leaves or nullifiers is
// in `seen` (the transaction's pool logs, lowercased). Shared with the pool index (pool-index.cjs).
function lockNullifiersFrom(input, seen) {
  const out = [];
  for (const pv of settleCalls(input)) {
    let f; try { f = pvArrays(pv); } catch { continue; }
    if (!f.lockNullifiers.length) continue;
    if ([...f.leaves, ...f.nullifiers].some((x) => seen.has(x.toLowerCase()))) out.push(...f.lockNullifiers); // the call ran
  }
  return out;
}
// Bridge mints: the burn nullifiers (field 8, burnsConsumed) of the settle calls in `input` that ran, by the same rule.
function burnNullifiersFrom(input, seen) {
  const out = [];
  for (const pv of settleCalls(input)) {
    let f; try { f = pvArrays(pv); } catch { continue; }
    if (f.burns.length && [...f.leaves, ...f.nullifiers].some((x) => seen.has(x.toLowerCase()))) out.push(...f.burns);
  }
  return out;
}
async function lockNullifiersOf(txHash, leaves, nullifiers) {
  const tx = await rpc(1, 'eth_getTransactionByHash', [txHash], { ttlMs: (x) => (x ? 24 * 3600_000 : 10_000) });
  if (!tx?.input) throw new Error('transaction not returned'); // unread calldata must not look like "no lock nullifiers"
  return lockNullifiersFrom(tx.input, new Set([...leaves, ...nullifiers].map((x) => x.toLowerCase())));
}

async function verifyChainBlock(block) {
  return (await cached(`chain:verify:v2:${block.hash}`, async () => {
    // The transaction (for lock nullifiers in its calldata) is fetched alongside the receipt; the rpc cache shares it.
    rpc(1, 'eth_getTransactionByHash', [block.tx], { ttlMs: (x) => (x ? 24 * 3600_000 : 10_000) }).catch(() => {});
    const receipt = await rpc(1, 'eth_getTransactionReceipt', [block.tx], { ttlMs: (x) => (x ? 24 * 3600_000 : 10_000) });
    if (!receipt) return { status: 'unverifiable', reason: 'anchoring transaction not found' };
    if (receipt.status !== '0x1') return { status: 'unverifiable', reason: 'anchoring transaction reverted' };
    const events = decodePoolLogs(receipt);
    const leaves = [...events.filter((e) => e.type === 'leaves').flatMap((e) => e.leaves), ...events.filter((e) => e.type === 'lockLeaves').flatMap((e) => e.lockLeaves)];
    const noteNullifiers = events.filter((e) => e.type === 'nullifiers').flatMap((e) => e.nullifiers);
    let calldataRead = true;
    const lockNfs = await lockNullifiersOf(block.tx, leaves, noteNullifiers).catch(() => { calldataRead = false; return []; });
    const nullifiers = [...noteNullifiers, ...lockNfs];
    const computed = blockHash({ prev: block.prev, height: block.height, ethBlock: block.ethBlock, tx: block.tx, leaves, nullifiers });
    if (computed === String(block.hash).toLowerCase()) return { status: 'verified', computed };
    if (!calldataRead) return { status: 'unverifiable', computed, reason: 'settle calldata could not be read' };
    return { status: 'mismatch', computed, reason: 'recomputed hash differs' };
  }, { ttlMs: (r) => (r.status === 'unverifiable' ? 60_000 : 24 * 3600_000), staleMs: 24 * 3600_000 })).data;
}

module.exports = { verifyChainBlock, blockHash, lockNullifiersFrom, burnNullifiersFrom };
