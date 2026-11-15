// The Tacit chain rebuilt by this site from Ethereum (no Tacit API). The rule is Tacit's own (worker/src/tacit-chain.js in
// their repository): height 0 is the first transaction that changed the pool's notes, each later one in chain order is
// the next height, a wrap-only transaction is no block, and
//   hash = keccak256(prev ‖ uint64 height ‖ uint64 ethBlock ‖ tx ‖ keccak256(leaves…) ‖ keccak256(nullifiers…)).
// Rebuilt from deploy on 2026-11-15, every block matched /prover/blocks (12,361 blocks, same head hash). The Verifier
// keeps comparing the newest block with Tacit's, so a divergence (for example a lock row Tacit's index sets aside)
// shows at once.
const { blockHash } = require('./chain-verify.cjs');

const KEEP = 1000; // newest blocks kept with their details (Tacit's API keeps 200)
const ZERO = `0x${'00'.repeat(32)}`;
const emptyChain = () => ({ height: -1, hash: ZERO, blocks: [] });

// Chain the block bodies (pool-index.cjs) onto `chain`; returns the new blocks and the new tip.
function extend(chain, bodies = []) {
  let { height, hash } = chain;
  const made = [];
  for (const b of bodies) {
    const h = height + 1;
    const x = blockHash({ prev: hash, height: h, ethBlock: b.ethBlock, tx: b.tx, leaves: b.leaves, nullifiers: b.nullifiers });
    made.push({ height: h, hash: x, prev: hash, ethBlock: b.ethBlock, tx: b.tx, notes: b.notes, spent: b.spent, deposits: b.deposits });
    height = h; hash = x;
  }
  return { height, hash, made };
}
// `chain` with `bodies` added for good, keeping the newest KEEP blocks.
function grow(chain, bodies) {
  const e = extend(chain, bodies);
  return { height: e.height, hash: e.hash, blocks: [...chain.blocks, ...e.made].slice(-KEEP) };
}

module.exports = { emptyChain, extend, grow, KEEP, ZERO };
