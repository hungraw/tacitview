// Checks a Tacit chain block in the visitor's browser, from raw Ethereum data (docs/TACIT-CHAIN.md):
//   hash = keccak256(prev ‖ uint64 height ‖ uint64 ethBlock ‖ tx ‖ keccak256(leaves…) ‖ keccak256(nullifiers…))
// leaves = note leaves then lock leaves; nullifiers = note nullifiers then lock nullifiers; all in log order. Lock
// nullifiers emit no event: they are field 18 of each settle call's publicValues in the calldata, counted for calls
// whose leaves or nullifiers the logs show ran. Everything here is written separately from the server's verifier
// (server/chain-verify.cjs), so the page's check does not rest on the server's decoding.

// ---- Keccak-256 (Ethereum's pre-NIST padding) ----
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
const MASK = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK);

export function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes); padded[bytes.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  const view = new DataView(padded.buffer);
  const A = [0, 1, 2, 3, 4].map(() => [0n, 0n, 0n, 0n, 0n]);
  for (let off = 0; off < padded.length; off += rate) {
    for (let j = 0; j < rate / 8; j++) A[j % 5][Math.floor(j / 5)] ^= view.getBigUint64(off + 8 * j, true);
    for (const rc of RC) {
      const C = [0, 1, 2, 3, 4].map((x) => A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4]);
      const D = [0, 1, 2, 3, 4].map((x) => C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1));
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] ^= D[x];
      const B = [[], [], [], [], []];
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y][(2 * x + 3 * y) % 5] = rotl(A[x][y], ROT[x][y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] = B[x][y] ^ (~B[(x + 1) % 5][y] & MASK & B[(x + 2) % 5][y]);
      A[0][0] ^= rc;
    }
  }
  const out = new Uint8Array(32), ov = new DataView(out.buffer);
  for (let j = 0; j < 4; j++) ov.setBigUint64(8 * j, A[j % 5][Math.floor(j / 5)], true);
  return out;
}

const strip = (h) => String(h || '').replace(/^0x/i, '').toLowerCase();
export const toHex = (b) => `0x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
const fromHex = (h) => { const s = strip(h); const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16); return out; };
const b32 = (h) => fromHex(strip(h).padStart(64, '0'));
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };
const concat = (parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const listHash = (xs) => keccak256(concat(xs.map(b32)));

// ---- ConfidentialPool logs ----
const POOL = '0x000000000ed1eabd231be41d93b719056f7febfc';
const TOPIC = {
  nullifiers: '0x576d91547505afce99e7ebe2baf1a0948b5915598105a55f40ba72fea86e875e', // NullifiersSpent(bytes32[])
  leaves: '0x7783fb256f5b4e1d4d8b79583488756286326ae15d9997d4098ce5432ed2708b', // LeavesInserted(uint256, bytes32[], bytes[])
  lockLeaves: '0x18df91ea83f965ece7a17fbab444175c3b2fd487524b95576215d8113d0b8662', // LockLeavesInserted(uint256, bytes32[])
};
const words = (hex) => strip(hex).match(/.{64}/g) || [];
const firstArray = (data) => { const ws = words(data), at = Number.parseInt(ws[0], 16) / 32, n = Number.parseInt(ws[at], 16); return ws.slice(at + 1, at + 1 + n).map((w) => `0x${w}`); };

function fromLogs(logs) {
  const pool = logs.filter((l) => strip(l.address) === strip(POOL)).sort((a, b) => Number(a.logIndex) - Number(b.logIndex));
  const pick = (topic) => pool.filter((l) => strip(l.topics?.[0]) === strip(topic)).map((l) => ({ logIndex: Number(l.logIndex), values: firstArray(l.data) }));
  return { leaves: pick(TOPIC.leaves), nullifiers: pick(TOPIC.nullifiers), lockLeaves: pick(TOPIC.lockLeaves), poolLogs: pool.length };
}

// ---- settle calldata: ConfidentialPool.settle(bytes publicValues, …) and the relayer's batched forms ----
const SEL = { settle: '717fd7f2', settleWithTip: '70b16a7d', relaySettle: 'fcccb833', relaySettleSeeded: 'e2b28725' };
const wordAt = (hex, byte) => BigInt(`0x${(hex.slice(byte * 2, byte * 2 + 64) || '').padEnd(64, '0')}`);
const bytesAt = (hex, byte) => { const len = Number(wordAt(hex, byte)); return hex.slice((byte + 32) * 2, (byte + 32 + len) * 2); };
const pvOf = (args) => bytesAt(args, Number(wordAt(args, 0)));
function settleCalls(input) {
  const raw = strip(input), sel = raw.slice(0, 8), args = raw.slice(8);
  if (sel === SEL.settle || sel === SEL.settleWithTip) return [pvOf(args)];
  if (sel === SEL.relaySettle || sel === SEL.relaySettleSeeded) {
    const arr = Number(wordAt(args, sel === SEL.relaySettle ? 0 : 32)), n = Number(wordAt(args, arr));
    return Array.from({ length: n }, (_, i) => pvOf(args.slice((arr + 32 + Number(wordAt(args, arr + 32 + i * 32))) * 2)));
  }
  const out = [];
  for (let i = raw.indexOf(SEL.settle, 8); i >= 0; i = raw.indexOf(SEL.settle, i + 1)) if (i % 2 === 0) { try { out.push(pvOf(raw.slice(i + 8))); } catch { /* not a call */ } }
  return out;
}
function pvArrays(pv) {
  const data = pv.slice(Number(wordAt(pv, 0)) * 2);
  const arr = (field) => { const off = Number(wordAt(data, field * 32)), n = Number(wordAt(data, off)); if (n > 4096 || (off + 32 + n * 32) * 2 > data.length) throw new Error('bad publicValues'); return Array.from({ length: n }, (_, i) => `0x${wordAt(data, off + 32 + i * 32).toString(16).padStart(64, '0')}`); };
  return { nullifiers: arr(3), leaves: arr(4), lockNullifiers: arr(18) };
}

// raw: the /views/chain-raw answer. Returns every intermediate value, for the page to show the work.
export function verifyBlock(raw) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const p = raw.published;
  const fromEth = fromLogs(raw.receipt.logs || []);
  const noteLeaves = fromEth.leaves.flatMap((x) => x.values), lockLeaves = fromEth.lockLeaves.flatMap((x) => x.values);
  const noteNullifiers = fromEth.nullifiers.flatMap((x) => x.values);
  const seen = new Set([...noteLeaves, ...lockLeaves, ...noteNullifiers].map(strip));
  const calls = settleCalls(raw.input);
  const lockNullifiers = [];
  for (const pv of calls) {
    let f; try { f = pvArrays(pv); } catch { continue; }
    if (f.lockNullifiers.length && [...f.leaves, ...f.nullifiers].some((x) => seen.has(strip(x)))) lockNullifiers.push(...f.lockNullifiers);
  }
  const leaves = [...noteLeaves, ...lockLeaves], nullifiers = [...noteNullifiers, ...lockNullifiers];
  const leavesHash = listHash(leaves), nullifiersHash = listHash(nullifiers);
  const computed = toHex(keccak256(concat([b32(p.prev), u64(p.height), u64(p.ethBlock), b32(p.tx), leavesHash, nullifiersHash])));
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return {
    prev: p.prev, height: p.height, ethBlock: p.ethBlock, tx: p.tx, published: strip(p.hash), computed: strip(computed), match: strip(p.hash) === strip(computed),
    leaves: { note: noteLeaves, lock: lockLeaves, logs: [...fromEth.leaves, ...fromEth.lockLeaves].map((x) => x.logIndex), hash: toHex(leavesHash) },
    nullifiers: { note: noteNullifiers, lock: lockNullifiers, logs: fromEth.nullifiers.map((x) => x.logIndex), hash: toHex(nullifiersHash) },
    settleCalls: calls.length, poolLogs: fromEth.poolLogs, ms,
    receiptMatches: strip(raw.receipt.transactionHash) === strip(p.tx) && Number.parseInt(raw.receipt.blockNumber, 16) === Number(p.ethBlock),
  };
}
