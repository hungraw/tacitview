// Parse a raw Bitcoin block (Esplora /block/:hash/raw) and decode every Tacit envelope in it.
// Independent of the Tacit API: the envelope list for a block comes straight from chain bytes.
const crypto = require('node:crypto');
const { decodeLeafScript, envelopeItems } = require('./envelope.cjs');

const sha256d = (buf) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest();

function reader(buf) {
  let o = 0;
  const r = {
    get offset() { return o; },
    u8: () => buf[o++],
    u32: () => { const v = buf.readUInt32LE(o); o += 4; return v; },
    bytes: (n) => { if (o + n > buf.length) throw new Error('block truncated'); const b = buf.subarray(o, o + n); o += n; return b; },
    varint: () => {
      const f = buf[o++];
      if (f < 0xfd) return f;
      if (f === 0xfd) { const v = buf.readUInt16LE(o); o += 2; return v; }
      if (f === 0xfe) { const v = buf.readUInt32LE(o); o += 4; return v; }
      const v = Number(buf.readBigUInt64LE(o)); o += 8; return v;
    },
  };
  return r;
}

// Returns { hash, txCount, envelopes: [{ txid, index, name, opcodeHex, assetId?, outputs? }] }.
function decodeBlock(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const r = reader(buf);
  const header = r.bytes(80);
  const hash = Buffer.from(sha256d(header)).reverse().toString('hex');
  const txCount = r.varint();
  const envelopes = [];
  for (let index = 0; index < txCount; index++) {
    const start = r.offset;
    r.u32(); // version
    let segwit = false;
    if (buf[r.offset] === 0x00 && buf[r.offset + 1] === 0x01) { segwit = true; r.bytes(2); }
    const bodyStart = r.offset;
    const vinCount = r.varint();
    for (let i = 0; i < vinCount; i++) { r.bytes(36); r.bytes(r.varint()); r.u32(); }
    const voutCount = r.varint();
    for (let i = 0; i < voutCount; i++) { r.bytes(8); r.bytes(r.varint()); }
    const bodyEnd = r.offset;
    const found = [];
    if (segwit) {
      for (let i = 0; i < vinCount; i++) {
        const items = [];
        const n = r.varint();
        for (let k = 0; k < n; k++) items.push(r.bytes(r.varint()));
        // Script-path spend: the envelope is witness item 1 (where Tacit's guest reads it) or the leaf (envelope.cjs
        // envelopeItems). vin[0] carries the op (SPEC §3.1); T_BTC_SPEND may ride any envelope input (§3.10).
        for (const item of envelopeItems(items)) {
          if (!item.includes('TACIT')) continue;
          let env = null;
          try { env = decodeLeafScript(item.toString('hex')); } catch { env = null; }
          if (env) { found.push({ vin: i, env }); break; }
        }
      }
    }
    const lockStart = r.offset;
    r.u32();
    if (found.length) {
      const stripped = Buffer.concat([buf.subarray(start, start + 4), buf.subarray(bodyStart, bodyEnd), buf.subarray(lockStart, lockStart + 4)]);
      const txid = Buffer.from(sha256d(stripped)).reverse().toString('hex');
      for (const { vin, env } of found) {
        envelopes.push({ txid, index, vin, name: env.name, opcodeHex: env.opcodeHex, ...(env.assetId ? { assetId: env.assetId, outputs: env.outputs } : {}), ...(env.nullifier ? { nullifier: env.nullifier, binding: env.binding } : {}) });
      }
    }
  }
  if (r.offset !== buf.length) throw new Error(`block parse ended at ${r.offset} of ${buf.length} bytes`);
  return { hash, txCount, envelopes };
}

module.exports = { decodeBlock };
