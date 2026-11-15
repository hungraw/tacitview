// Keccak-256 (the pre-NIST padding Ethereum uses), dependency-free. Small inputs only: used to verify Tacit chain
// block hashes. Checked against keccak256("transfer(address,uint256)") = a9059cbb… in test/offline.cjs.
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
const MASK = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK);

function permute(A) {
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

function keccak256(bytes) {
  const rate = 136;
  const data = Buffer.concat([Buffer.from(bytes), Buffer.from([0x01]), Buffer.alloc((rate - ((bytes.length + 1) % rate)) % rate)]);
  data[data.length - 1] |= 0x80;
  const A = [0, 1, 2, 3, 4].map(() => [0n, 0n, 0n, 0n, 0n]);
  for (let off = 0; off < data.length; off += rate) {
    for (let j = 0; j < rate / 8; j++) A[j % 5][Math.floor(j / 5)] ^= data.readBigUInt64LE(off + 8 * j);
    permute(A);
  }
  const out = Buffer.alloc(32);
  for (let j = 0; j < 4; j++) out.writeBigUInt64LE(A[j % 5][Math.floor(j / 5)], 8 * j);
  return out;
}

module.exports = { keccak256 };
