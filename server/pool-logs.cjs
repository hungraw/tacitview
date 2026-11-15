// Decode ConfidentialPool events straight from an Ethereum receipt (no Tacit API call).
// Event shapes were matched against /confidential/index records for the same logs:
//   nullifiers: topic0 0x576d9154…, data = bytes32[] nullifiers
//   leaves:     topic0 0x7783fb25…, topic1 = index of the first new leaf, data = (bytes32[] leaves, bytes[] memos)
// Any other pool event is reported by its topic, not guessed.

const POOL = '0x000000000ed1eabd231be41d93b719056f7febfc';
const NULLIFIERS = '0x576d91547505afce99e7ebe2baf1a0948b5915598105a55f40ba72fea86e875e';
const LEAVES = '0x7783fb256f5b4e1d4d8b79583488756286326ae15d9997d4098ce5432ed2708b';
// Other ConfidentialPool events, topic0 = keccak256 of the signature in contracts/src/ConfidentialPool.sol.
const OTHER = {
  '0xf5d1711d21af6f42622ab6237626933cefc42cc9f0663d81b7c4c7bc5ce99e44': 'wrap', // Wrap(bytes32 depositId, bytes32 assetId, uint256 amount)
  '0x1dcbefc1323b3b80f7cedfeb490313eff6ded6186b4cf10d72b383ee81d90c13': 'crossOut', // CrossOutRecorded(...)
  '0x18df91ea83f965ece7a17fbab444175c3b2fd487524b95576215d8113d0b8662': 'lockLeaves', // LockLeavesInserted(uint256, bytes32[])
  '0x288856bf0e0f2858e11544264dcf77f1212699edb15bcf447343b07b471bce9a': 'bitcoinConsumed', // BitcoinNotesConsumed(bytes32[], bytes32)
  '0xee1b9d2771b0fb386e48ce3feadb63ccbd36550d1953051cfd2d5890cc3a0b7d': 'cdpPosition', // CdpPositionInserted(bytes32)
  '0x2dcb7e1d588ab99cccaa0e9a2f69798e1e9ca87a30856228f895c2f6b34a905b': 'assetRegistered', // AssetRegistered(...)
};

const words = (hex) => String(hex || '').replace(/^0x/, '').match(/.{64}/g) || [];
const num = (w) => Number.parseInt(w, 16);

function bytes32Array(ws, offsetWords) {
  const len = num(ws[offsetWords]);
  return ws.slice(offsetWords + 1, offsetWords + 1 + len).map((w) => `0x${w}`);
}

function bytesArrayLengths(ws, offsetWords) {
  const len = num(ws[offsetWords]);
  const base = offsetWords + 1;
  return Array.from({ length: len }, (_, i) => num(ws[base + num(ws[base + i]) / 32]));
}

function decodePoolLogs(receipt) {
  return (receipt?.logs || []).filter((l) => String(l.address).toLowerCase() === POOL).map((l) => {
    const logIndex = Number.parseInt(l.logIndex, 16);
    const topic = String(l.topics?.[0] || '').toLowerCase();
    const ws = words(l.data);
    try {
      if (topic === NULLIFIERS) return { type: 'nullifiers', logIndex, nullifiers: bytes32Array(ws, num(ws[0]) / 32) };
      if (topic === LEAVES) {
        return { type: 'leaves', logIndex, leafIndex: num(String(l.topics[1]).slice(2)), leaves: bytes32Array(ws, num(ws[0]) / 32), memoBytes: bytesArrayLengths(ws, num(ws[1]) / 32) };
      }
      if (OTHER[topic] === 'wrap') return { type: 'wrap', logIndex, assetId: l.topics[2], amount: BigInt(`0x${ws[0]}`).toString() }; // amount is public (SPEC §11 boundary)
      if (OTHER[topic] === 'lockLeaves') return { type: 'lockLeaves', logIndex, firstLockIndex: num(String(l.topics[1]).slice(2)), lockLeaves: bytes32Array(ws, num(ws[0]) / 32) };
      if (OTHER[topic]) return { type: OTHER[topic], logIndex };
    } catch { /* fall through to the raw form */ }
    return { type: 'other', logIndex, topic };
  });
}

// The deployment a Bitcoin bridge burn must name to be mintable by this pool: ConfidentialPool's CHAIN_BINDING,
// keccak256(abi.encodePacked(block.chainid, address(this))) with chain id 1.
const POOL_BINDING = require('./keccak.cjs').keccak256(Buffer.concat([Buffer.alloc(31), Buffer.from([1]), Buffer.from(POOL.slice(2), 'hex')])).toString('hex');

module.exports = { decodePoolLogs, POOL, NULLIFIERS, LEAVES, POOL_BINDING };
