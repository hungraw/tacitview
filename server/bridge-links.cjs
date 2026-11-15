// Links between a Bitcoin bridge burn and the Ethereum mint that pays it. The burn's 161-byte envelope publishes its
// nullifier ν; the mint spends that same ν in the ConfidentialPool, so a NullifiersSpent log carrying ν is the mint.
// Pool logs are read for the last ~9,300 Ethereum blocks (~31 h), under the free RPCs' log depth.
const { cached } = require('./upstream.cjs');
const { rpc } = require('./rpc.cjs');
const { decodePoolLogs, POOL, NULLIFIERS } = require('./pool-logs.cjs');

const DEPTH = 9_300;
const SECS = 12; // Ethereum block time, for "about when" estimates

// ν (64 hex, no 0x) -> { tx, block, time }, for every nullifier the pool spent in the last ~31 h.
async function nullifierIndex() {
  return (await cached('bridge:nullifier-index', async () => {
    const head = Number.parseInt(await rpc(1, 'eth_blockNumber', [], { ttlMs: 10_000 }), 16);
    const top = await rpc(1, 'eth_getBlockByNumber', [`0x${head.toString(16)}`, false], { ttlMs: 10_000 });
    const headTime = Number.parseInt(top.timestamp, 16);
    const logs = await rpc(1, 'eth_getLogs', [{ address: POOL, topics: [NULLIFIERS], fromBlock: `0x${(head - DEPTH).toString(16)}`, toBlock: `0x${head.toString(16)}` }], { ttlMs: 30_000 });
    const map = new Map();
    for (const e of decodePoolLogs({ logs })) {
      const raw = logs.find((l) => Number.parseInt(l.logIndex, 16) === e.logIndex && (e.tx == null || l.transactionHash === e.tx));
      const block = raw ? Number.parseInt(raw.blockNumber, 16) : null;
      for (const n of e.nullifiers || []) map.set(String(n).replace(/^0x/, '').toLowerCase(), { tx: raw?.transactionHash || null, block, time: block == null ? null : headTime - (head - block) * SECS });
    }
    return { map, head, headTime, fromBlock: head - DEPTH };
  }, { ttlMs: 30_000 })).data;
}

// ν -> Bitcoin burn, filled as the burns card decodes burns (this instance's memory).
const burnByNu = new Map();
const rememberBurn = (nu, burn) => { if (nu) burnByNu.set(String(nu).replace(/^0x/, '').toLowerCase(), burn); };
const burnFor = (nu) => burnByNu.get(String(nu || '').replace(/^0x/, '').toLowerCase()) || null;

module.exports = { nullifierIndex, rememberBurn, burnFor, DEPTH };
