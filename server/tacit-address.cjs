// Structural decoder for unified Tacit addresses (tacit1… mainnet, tactt1… signet, tacrt1… regtest).
// Layout from src-company/tacit dapp/tacit-address.js: bech32m, payload [version 0x00][flags][lanes].
// Lanes: 0x01 Bitcoin spend‖scan (66, required), 0x02 Ethereum-side key (33), 0x04 pool keys (97),
// 0x80 = Ethereum-side key is the Bitcoin spend key (no bytes). secp256k1 keys are checked to be valid curve points;
// the pool lane's BabyJub keys (A, N) are not.

const crypto = require('node:crypto');

const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M = 0x2bc830a3;
const HRPS = { tacit: 'mainnet', tactt: 'signet', tacrt: 'regtest' };

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
const expandHrp = (hrp) => [...hrp].map((c) => c.charCodeAt(0) >>> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0; const out = []; const maxv = (1 << to) - 1;
  for (const value of data) { acc = (acc << from) | value; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); } }
  if (pad && bits) out.push((acc << (to - bits)) & maxv);
  return out;
}

function encodeBech32m(hrp, bytes) {
  const data = convertBits(bytes, 8, 5, true);
  const mod = polymod(expandHrp(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ BECH32M;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${data.concat(checksum).map((d) => ALPHABET[d]).join('')}`;
}

// The wallet's plain Bitcoin address: native SegWit v0 (P2WPKH) of the Bitcoin spend key, as the Tacit wallet shows it.
// Checked against a real wallet: spend key 03440cca… gives bc1qel5autl0ff4z47yfegk5y0r0arda5xw39qstgs.
function p2wpkhAddress(pubkey, network) {
  const hrp = network === 'mainnet' ? 'bc' : network === 'regtest' ? 'bcrt' : 'tb';
  const h160 = crypto.createHash('ripemd160').update(crypto.createHash('sha256').update(Buffer.from(pubkey)).digest()).digest();
  const data = [0, ...convertBits([...h160], 8, 5, true)];
  const mod = polymod(expandHrp(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ 1; // bech32 (v0), not bech32m
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${data.concat(checksum).map((d) => ALPHABET[d]).join('')}`;
}

function isSecpPoint(bytes) {
  if (bytes.length !== 33 || (bytes[0] !== 2 && bytes[0] !== 3)) return false;
  try { crypto.ECDH.convertKey(Buffer.from(bytes), 'secp256k1', undefined, undefined, 'uncompressed'); return true; } catch { return false; }
}

function decodeTacitAddress(input) {
  const addr = String(input || '').trim();
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return { ok: false, error: 'mixed case' };
  const lower = addr.toLowerCase();
  const sep = lower.lastIndexOf('1');
  const hrp = lower.slice(0, sep);
  if (!HRPS[hrp]) return { ok: false, error: 'not a tacit unified address prefix' };
  const d5 = [...lower.slice(sep + 1)].map((c) => ALPHABET.indexOf(c));
  if (d5.length < 6 || d5.includes(-1)) return { ok: false, error: 'invalid characters' };
  if (polymod(expandHrp(hrp).concat(d5)) !== BECH32M) return { ok: false, error: 'checksum mismatch' };
  const bytes = convertBits(d5.slice(0, -6), 5, 8, false);
  const [version, flags] = bytes;
  if (version !== 0) return { ok: false, error: `unsupported version ${version}` };
  if (!(flags & 0x01)) return { ok: false, error: 'missing Bitcoin lane' };
  if ((flags & 0x02) && (flags & 0x80)) return { ok: false, error: 'Ethereum-side key named twice' };
  const want = 2 + 66 + ((flags & 0x02) ? 33 : 0) + ((flags & 0x04) ? 97 : 0);
  const unknownBits = flags & ~0x87;
  if (unknownBits ? bytes.length < want : bytes.length !== want) return { ok: false, error: `payload length ${bytes.length}, expected ${want}` };
  const keys = [['Bitcoin spend key', bytes.slice(2, 35)], ['Bitcoin scan key', bytes.slice(35, 68)]];
  if (flags & 0x02) keys.push(['Ethereum-side key', bytes.slice(68, 101)]);
  if (flags & 0x04) keys.push(['Pool view key', bytes.slice(68 + ((flags & 0x02) ? 33 : 0), 101 + ((flags & 0x02) ? 33 : 0))]);
  const bad = keys.find(([, key]) => !isSecpPoint(key));
  if (bad) return { ok: false, error: `${bad[0]} is not a valid secp256k1 point` };
  const lanes = ['bitcoin (spend + scan keys)'];
  if (flags & 0x02) lanes.push('ethereum-side key');
  if (flags & 0x80) lanes.push('ethereum-side key = bitcoin spend key');
  if (flags & 0x04) lanes.push('shielded pool keys');
  let poolAddress = null;
  if (flags & 0x04 && HRPS[hrp] !== 'regtest') {
    const at = 68 + ((flags & 0x02) ? 33 : 0);
    poolAddress = encodeBech32m(HRPS[hrp] === 'mainnet' ? 'bp' : 'tbp', bytes.slice(at, at + 97));
  }
  return { ok: true, network: HRPS[hrp], version, flags, lanes, poolAddress, bitcoinAddress: p2wpkhAddress(bytes.slice(2, 35), HRPS[hrp]), unknownLaneBits: unknownBits || 0, keys: Object.fromEntries(keys.map(([name, key]) => [name, Buffer.from(key).toString('hex')])) };
}

module.exports = { decodeTacitAddress, encodeBech32m, p2wpkhAddress };
