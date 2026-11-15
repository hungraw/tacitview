// The EVM pool's history since deploy, from server/data/evm-snapshot.json.gz (made by scripts/evm-snapshot.mjs):
// every deposit (block, sender, amount in wei) and withdrawal (block, recipient, amount) on each chain, up to the
// snapshot's `through` block. Read once, lazily; blocks after `through` come from the live scan (measured-privacy.cjs).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const FILE = path.join(__dirname, 'data', 'evm-snapshot.json.gz');
let snap; // undefined: not read yet; null: missing or unreadable

// Withdrawals carry a fourth column: the wallet that sent the transaction (`by`), or -1 when a relayer sent it.
function unpack([deltas, who, amounts, by], raw) {
  let block = 0;
  return deltas.map((d, i) => {
    block += d;
    const row = { block, addr: raw.addrs[who[i]], amount: raw.amounts[amounts[i]] };
    if (by) { row.relayed = by[i] < 0; row.by = by[i] < 0 ? null : raw.addrs[by[i]]; }
    return row;
  });
}

function load() {
  if (snap !== undefined) return snap;
  if (!fs.existsSync(FILE)) return null; // not built yet: look again next time
  try {
    const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)).toString('utf8'));
    snap = { builtAt: raw.builtAt, chains: {} };
    for (const [chain, c] of Object.entries(raw.chains)) snap.chains[chain] = { through: c.through, anchors: c.anchors || null, deposits: unpack(c.deposits, raw), withdrawals: unpack(c.withdrawals, raw) };
  } catch { snap = null; }
  return snap;
}

// The last block the snapshot covers on a chain (null without a snapshot: the live scan's 24 h is all there is).
const through = (chain) => load()?.chains[chain]?.through ?? null;

module.exports = { load, through };
