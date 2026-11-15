// Decode the Tacit envelope from a reveal transaction (SPEC.md §3.1, §3.9).
// Leaf script: <signer(32)> OP_CHECKSIG OP_FALSE OP_IF "TACIT" <version> <payload pushes…> OP_ENDIF
// payload = opcode(1) ‖ body. vin[0] carries the envelope; witness = [sig, leaf_script, control_block].

const OP_FALSE = 0x00, OP_IF = 0x63, OP_ENDIF = 0x68;
const MAGIC = Buffer.from('TACIT', 'ascii');

// Names from the opcode tables in SPEC.md (src-company/tacit), extracted mechanically.
// Codes the spec names only as a range get that range's label; anything else shows as hex, never guessed.
const OPCODES = {
  0x21: 'T_CETCH', 0x22: 'T_CXFER_BPP', 0x23: 'T_CXFER', 0x24: 'T_MINT', 0x25: 'T_BURN', 0x26: 'T_AXFER',
  0x27: 'T_PETCH', 0x28: 'T_PMINT', 0x29: 'T_DEPOSIT', 0x2A: 'T_WITHDRAW', 0x2B: 'T_DROP', 0x2C: 'T_DCLAIM',
  0x2D: 'T_LP_ADD', 0x2E: 'T_LP_REMOVE', 0x2F: 'T_SWAP_BATCH', 0x31: 'T_PROTOCOL_FEE_CLAIM', 0x32: 'T_SWAP_VAR',
  0x33: 'T_SWAP_ROUTE', 0x34: 'T_FARM_INIT', 0x35: 'T_LP_BOND', 0x36: 'T_LP_UNBOND', 0x37: 'T_AXFER_VAR',
  0x38: 'T_WRAPPER_ATTEST', 0x39: 'T_CXFER_BOUND', 0x3B: 'T_LP_HARVEST', 0x3C: 'T_AXFER_BPP', 0x3D: 'T_AXFER_VAR_BPP',
  0x3E: 'T_FARM_REFUND', 0x5B: 'T_PREAUTH_BID', 0x5C: 'T_PREAUTH_BID_VAR', 0x65: 'T_CROSSOUT_MINT', 0x66: 'T_CBTC_LOCK',
  0x67: 'T_CBTC_REDEEM', 0x68: 'T_BTC_CALL', 0x69: 'T_ETH_CALL', 0x6C: 'T_BTC_SHIELD', 0x6D: 'T_BTC_SPEND',
};
const RANGES = [[0x43, 0x48, 'cBTC.zk slot'], [0x60, 0x64, 'legacy tETH bridge op']];
const BRIDGE_BURN_BYTES = 161; // 0x2B folds as a bridge burn only at exactly this payload size (SPEC §6)

function opName(code, payloadBytes) {
  if (code === 0x2B && payloadBytes === BRIDGE_BURN_BYTES) return 'bridge burn';
  if (OPCODES[code]) return OPCODES[code];
  const range = RANGES.find(([lo, hi]) => code >= lo && code <= hi);
  return range ? range[2] : null;
}

// Yields { op, data } for each script op. `data` is set for pushes.
function* readOps(script) {
  let i = 0;
  while (i < script.length) {
    const op = script[i++];
    let size = null;
    if (op >= 0x01 && op <= 0x4b) size = op;
    else if (op === 0x4c) { size = script[i]; i += 1; }
    else if (op === 0x4d) { size = script.readUInt16LE(i); i += 2; }
    else if (op === 0x4e) { size = script.readUInt32LE(i); i += 4; }
    if (size !== null) {
      if (i + size > script.length) throw new Error('Push runs past end of script');
      yield { op, data: script.subarray(i, i + size) };
      i += size;
    } else yield { op, data: op === OP_FALSE ? Buffer.alloc(0) : null };
  }
}

function decodeLeafScript(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]*$/i.test(hex)) return null;
  const ops = [...readOps(Buffer.from(hex, 'hex'))];
  for (let k = 0; k + 2 < ops.length; k++) {
    if (ops[k].op !== OP_FALSE || ops[k + 1].op !== OP_IF) continue;
    // As Tacit's reflection guest reads it (extract_taproot_envelope): every push up to OP_ENDIF joined, then a
    // "TACIT" ‖ version frame. Wallets split the bytes into pushes differently ("TACIT" and the version as their own
    // pushes, or packed with the payload), so the frame is matched on the joined bytes, never on push boundaries.
    const chunks = [];
    for (let j = k + 2; j < ops.length && ops[j].op !== OP_ENDIF; j++) if (ops[j].data) chunks.push(ops[j].data);
    const joined = Buffer.concat(chunks);
    if (joined.length <= MAGIC.length + 1 || !joined.subarray(0, MAGIC.length).equals(MAGIC)) continue;
    const version = joined[MAGIC.length];
    const payload = joined.subarray(MAGIC.length + 1);
    const code = payload[0];
    const out = { version, opcode: code, opcodeHex: `0x${code.toString(16).padStart(2, '0')}`, name: opName(code, payload.length), payloadBytes: payload.length };
    // Bridge burn (SPEC §3.7): op ‖ asset(32) ‖ pool_root(32, unused) ‖ ν(32) ‖ dest_commitment ‖ binding. The ν is
    // the burned note's nullifier; the pool spends the same ν when it mints the burn, so it links burn to mint.
    // The last 32 bytes name the pool deployment that may mint it: keccak256(chainid ‖ pool address) (ConfidentialPool CHAIN_BINDING).
    if (out.name === 'bridge burn') { out.assetId = payload.subarray(1, 33).toString('hex'); out.nullifier = payload.subarray(65, 97).toString('hex'); out.binding = payload.subarray(129, 161).toString('hex'); }
    // Confidential transfer layout (SPEC §3.4): op ‖ [binding(32) for 0x39] ‖ asset_id(32) ‖ kernel_sig(64) ‖ N(1) ‖ (C(33) ‖ amount_ct(8))×N ‖ …
    if (code === 0x22 || code === 0x23 || code === 0x39) {
      const at = code === 0x39 ? 33 : 1;
      if (payload.length >= at + 32 + 64 + 1) {
        out.assetId = payload.subarray(at, at + 32).toString('hex');
        const n = payload[at + 96];
        const rpAt = at + 97 + 41 * n;
        // Only report the layout when the declared sizes add up to the payload exactly (trailing bytes are invalid).
        if ([1, 2, 4, 8].includes(n) && payload.length >= rpAt + 2 && rpAt + 2 + payload.readUInt16LE(rpAt) === payload.length) {
          out.outputs = n;
          const rp = payload.readUInt16LE(rpAt);
          out.layout = [['op', 1], ...(code === 0x39 ? [['chain binding', 32]] : []), ['asset id', 32], ['kernel signature', 64], ['N', 1],
            ['commitments + encrypted amounts', 41 * n], ['proof length', 2], ['range proof', rp]].map(([part, bytes]) => ({ part, bytes }));
        }
        else delete out.assetId;
      }
    }
    return out;
  }
  return null;
}

// The witness items that can carry an envelope: item 1, where Tacit's reflection guest reads it
// (extract_taproot_envelope), and the tapleaf (second to last). They are the same item in the usual
// [signature, leaf, control] spend; some wallets add an item, as in [signature, envelope, leaf, control].
const envelopeItems = (items) => (items.length < 3 ? [] : items.length === 3 ? [items[1]] : [items[1], items[items.length - 2]]);

// Esplora tx -> envelope summary or null when vin[0] carries no Tacit envelope.
function decodeTx(tx) {
  const witness = tx?.vin?.[0]?.witness;
  if (!Array.isArray(witness)) return null;
  for (const item of envelopeItems(witness)) {
    try { const env = decodeLeafScript(item); if (env) return env; } catch { /* not an envelope */ }
  }
  return null;
}

module.exports = { decodeLeafScript, decodeTx, envelopeItems, OPCODES };
