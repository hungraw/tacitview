// Decodes what a ConfidentialPool settle call publishes: the PublicValues struct (contracts/src/ConfidentialPool.sol,
// abi.decode(publicValues, (PublicValues))). Calldata forms follow src/verify-block.js: settle and settleWithTip
// carry one publicValues; relaySettle and relaySettleSeeded carry an array of settle calls.
// Field numbers are the struct's order; static tuples sit inline in their arrays, dynamic ones (CDP records) are only
// counted here.
const SEL = { settle: '717fd7f2', settleWithTip: '70b16a7d', relaySettle: 'fcccb833', relaySettleSeeded: 'e2b28725' };
const strip = (h) => String(h || '').replace(/^0x/, '').toLowerCase();
const wordAt = (hex, byte) => BigInt(`0x${(hex.slice(byte * 2, byte * 2 + 64) || '').padEnd(64, '0')}`);
const hexAt = (hex, byte) => `0x${hex.slice(byte * 2, byte * 2 + 64).padEnd(64, '0')}`;
const bytesAt = (hex, byte) => { const len = Number(wordAt(hex, byte)); return hex.slice((byte + 32) * 2, (byte + 32 + len) * 2); };
const pvOf = (args) => bytesAt(args, Number(wordAt(args, 0)));

function settleCalls(input) {
  const raw = strip(input), sel = raw.slice(0, 8), args = raw.slice(8);
  if (sel === SEL.settle || sel === SEL.settleWithTip) return [pvOf(args)];
  if (sel === SEL.relaySettle || sel === SEL.relaySettleSeeded) {
    const arr = Number(wordAt(args, sel === SEL.relaySettle ? 0 : 32)), n = Number(wordAt(args, arr));
    if (n > 64) return [];
    return Array.from({ length: n }, (_, i) => pvOf(args.slice((arr + 32 + Number(wordAt(args, arr + 32 + i * 32))) * 2)));
  }
  return [];
}

const F = { nullifiers: 3, leaves: 4, deposits: 5, withdrawals: 6, fees: 7, burnsConsumed: 8, crossOuts: 9, swaps: 13, liquidity: 14, lockLeaves: 17, lockNullifiers: 18, cdpMints: 22, cdpCloses: 23, cdpLiquidations: 24, cdpTopups: 25, cbtcMints: 26, burnIds: 29, harvests: 30 };

function decodePv(pv) {
  const data = pv.slice(Number(wordAt(pv, 0)) * 2);
  const at = (field) => Number(wordAt(data, field * 32));
  const count = (field) => { const n = Number(wordAt(data, at(field))); if (n > 4096) throw new Error('bad publicValues'); return n; };
  // An array of static tuples of `width` words: element i, word j.
  const values = (field) => { const off = at(field), n = count(field); return Array.from({ length: n }, (_, i) => hexAt(data, off + 32 + i * 32)); };
  const rows = (field, width) => { const off = at(field), n = count(field); return Array.from({ length: n }, (_, i) => Array.from({ length: width }, (_, j) => off + 32 + (i * width + j) * 32)); };
  return {
    nullifiers: count(F.nullifiers), leaves: count(F.leaves), deposits: count(F.deposits),
    withdrawals: rows(F.withdrawals, 3).map(([a, r, v]) => ({ assetId: hexAt(data, a), recipient: `0x${hexAt(data, r).slice(26)}`, value: wordAt(data, v).toString() })),
    fees: rows(F.fees, 2).map(([a, v]) => ({ assetId: hexAt(data, a), value: wordAt(data, v).toString() })),
    burnsMinted: count(F.burnsConsumed), burnNullifiers: values(F.burnsConsumed), crossOuts: count(F.crossOuts),
    swaps: rows(F.swaps, 7).map(([p, a0, b0, a1, b1]) => ({ poolId: hexAt(data, p), aPre: wordAt(data, a0).toString(), bPre: wordAt(data, b0).toString(), aPost: wordAt(data, a1).toString(), bPost: wordAt(data, b1).toString() })),
    liquidity: rows(F.liquidity, 7).map(([p, a0, b0, s0, a1, b1, s1]) => ({ poolId: hexAt(data, p), aPre: wordAt(data, a0).toString(), bPre: wordAt(data, b0).toString(), aPost: wordAt(data, a1).toString(), bPost: wordAt(data, b1).toString(), sharesPre: wordAt(data, s0).toString(), sharesPost: wordAt(data, s1).toString() })),
    lockLeaves: count(F.lockLeaves), lockNullifiers: count(F.lockNullifiers),
    loans: count(F.cdpMints) + count(F.cdpCloses) + count(F.cdpLiquidations) + count(F.cdpTopups),
    cbtcMints: rows(F.cbtcMints, 3).map(([, v]) => ({ sats: wordAt(data, v).toString() })),
    harvests: count(F.harvests),
  };
}

// Every batch in a settle transaction, merged. Returns null when the input is not a settle call or does not decode.
function decodeSettle(input) {
  let batches;
  try { batches = settleCalls(input).map(decodePv); } catch { return null; }
  if (!batches.length) return null;
  const sum = (k) => batches.reduce((a, b) => a + b[k], 0);
  const all = (k) => batches.flatMap((b) => b[k]);
  return {
    batches: batches.length, nullifiers: sum('nullifiers'), leaves: sum('leaves'), deposits: sum('deposits'),
    withdrawals: all('withdrawals'), fees: all('fees'), burnsMinted: sum('burnsMinted'), burnNullifiers: all('burnNullifiers'), crossOuts: sum('crossOuts'),
    swaps: all('swaps'), liquidity: all('liquidity'), lockLeaves: sum('lockLeaves'), lockNullifiers: sum('lockNullifiers'),
    loans: sum('loans'), cbtcMints: all('cbtcMints'), harvests: sum('harvests'),
  };
}

module.exports = { decodeSettle };
