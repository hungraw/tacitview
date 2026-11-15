// Bridge and pool state read straight from the Ethereum contracts (no Tacit API).
// Selectors and event topics computed with Keccak-256 from the signatures in contracts/src/ConfidentialPool.sol
// and contracts/src/lib/BitcoinLightRelay.sol (src-company/tacit); the two observed topics match on mainnet.

const { cached } = require('./upstream.cjs');
const { rpc } = require('./rpc.cjs');
const { decodePoolLogs, POOL } = require('./pool-logs.cjs');

const RELAY = '0x20a6ddc2c6e620c6248b5a34e85996516fdd19d0';
const SEL = {
  tipHeight: '1fd4827a', blockHeight: '59a53331', attestedReflectionTip: '182f6171', attestedReflectionDigest: 'b909cdaf',
  nextLeafIndex: '0be4f422', currentRoot: 'fdab463d', attestedBitcoinConsumedCount: '281d8cc9', attestedCrossOutCount: 'a6f8c9d6',
};

const CONFIRMATIONS = 24; // REFLECTION_CONFIRMATIONS, a protocol parameter of the Tacit worker (not readable on-chain); the one place it is set
const call = (to, data, block) => rpc(1, 'eth_call', [{ to, data: `0x${data}` }, block], { ttlMs: 15_000 });
const uint = (hex) => Number(BigInt(hex));

// One consistent snapshot: every read is pinned to the same Ethereum block.
async function bridgeOnChain() {
  return (await cached('chain:bridge', async () => {
    const head = Number.parseInt(await rpc(1, 'eth_blockNumber', [], { ttlMs: 10_000 }), 16);
    const block = `0x${head.toString(16)}`;
    const [relayTip, attestedTip, digest, nextLeaf, root, consumed, crossOuts] = await Promise.all([
      call(RELAY, SEL.tipHeight, block), call(POOL, SEL.attestedReflectionTip, block), call(POOL, SEL.attestedReflectionDigest, block),
      call(POOL, SEL.nextLeafIndex, block), call(POOL, SEL.currentRoot, block), call(POOL, SEL.attestedBitcoinConsumedCount, block),
      call(POOL, SEL.attestedCrossOutCount, block),
    ]);
    const attestedHeight = uint(await call(RELAY, SEL.blockHeight + attestedTip.slice(2), block));
    // The relay stores block hashes in internal byte order; show the usual reversed display form too.
    const attestedTipHash = Buffer.from(attestedTip.slice(2), 'hex').reverse().toString('hex');
    return {
      // attestable = relay tip − 24: the newest block the pool may attest (Tacit's /reflection/status tipHeight means this).
      ethBlock: head, relayTipHeight: uint(relayTip), attestableHeight: uint(relayTip) - CONFIRMATIONS, attestedHeight, attestedTipHash,
      reflectionDigest: digest, nextLeafIndex: uint(nextLeaf), currentRoot: root,
      attestedConsumedCount: uint(consumed), attestedCrossOutCount: uint(crossOuts),
      contracts: { relay: RELAY, pool: POOL },
    };
  }, { ttlMs: 15_000 })).data;
}

// Latest pool events from eth_getLogs, newest first. Widens the window until it has enough events.
const LOG_WINDOWS = [2_000, 10_000]; // ~6.7h, ~33h; publicnode serves up to 10,000 blocks
async function recentPoolEvents(want = 20) {
  return (await cached(`chain:pool-events:${want}`, async () => {
    const head = Number.parseInt(await rpc(1, 'eth_blockNumber', [], { ttlMs: 10_000 }), 16);
    let logs = [];
    for (const span of LOG_WINDOWS) {
      logs = await rpc(1, 'eth_getLogs', [{ address: POOL, fromBlock: `0x${(head - span).toString(16)}`, toBlock: `0x${head.toString(16)}` }], { ttlMs: 15_000 });
      if (logs.length >= want) break;
    }
    const byLog = new Map(logs.map((l) => [`${l.transactionHash}:${Number.parseInt(l.logIndex, 16)}`, l]));
    const decoded = decodePoolLogs({ logs }).map((e) => {
      const raw = logs.find((l) => Number.parseInt(l.logIndex, 16) === e.logIndex && byLog.has(`${l.transactionHash}:${e.logIndex}`));
      return { ...e, block: Number.parseInt(raw.blockNumber, 16), tx: raw.transactionHash };
    });
    decoded.sort((a, b) => b.block - a.block || b.logIndex - a.logIndex);
    return { ethBlock: head, events: decoded.slice(0, want) };
  }, { ttlMs: 20_000 })).data;
}

// Ethereum-side assets, read from the contracts (selectors match dapp/weld/stats/read.js in the Tacit repo).
const ENGINE = '0x000000003f608bddf0ca45934003ffb9dbdf70db';
const TOKENS = { // public ERC-20s, all 18 decimals (read with decimals() on 2026-11-10)
  TAC: '0xa1313eb9f3a445606d9583bcac3ebeb56a858279', wTAC: '0x2018139a8fdd3666855be3315c7683b4d6ab7aef',
  tacBTC: '0xdf1d99148beb7a9aff1d95c49b3d22b7ed90d696', tacUSD: '0x23cacffac2674514a6d4f6cd420b4cc2ac921564',
};
async function ethAssets() {
  return (await cached('chain:assets', async () => {
    const head = Number.parseInt(await rpc(1, 'eth_blockNumber', [], { ttlMs: 10_000 }), 16);
    const block = `0x${head.toString(16)}`;
    const names = Object.keys(TOKENS);
    const [backing, outstanding, cusdDec, cbtcDec, ...supplies] = await Promise.all([
      call(POOL, '9f5b61d9', block), // cbtcBackingSats(): live self-custody cBTC.zk lock sats behind cBTC
      call(ENGINE, 'a42542c0', block), // outstandingCusd(): cUSD principal across open positions (base units)
      call(ENGINE, '39b5099d', block), call(ENGINE, 'ad081714', block), // CUSD_DEC(), CBTC_DEC()
      ...names.map((n) => call(TOKENS[n], '18160ddd', block)), // totalSupply()
    ]);
    return {
      ethBlock: head,
      cbtc: { backingSats: BigInt(backing).toString(), decimals: uint(cbtcDec) },
      cusd: { outstanding: BigInt(outstanding).toString(), decimals: uint(cusdDec) },
      tokens: Object.fromEntries(names.map((n, i) => [n, { address: TOKENS[n], supply: BigInt(supplies[i]).toString(), decimals: 18 }])),
      contracts: { pool: POOL, engine: ENGINE },
    };
  }, { ttlMs: 60_000 })).data;
}

// The attested Bitcoin height as of an older Ethereum block: attestedReflectionTip at that block (a historical eth_call;
// publicnode refuses those as archive reads, drpc's free endpoint answers them), then the relay's height for that hash
// (the mapping never changes, so it is read at the head). Both are fixed once the block is final: kept a day.
async function attestedAt(blockNumber) {
  const block = `0x${blockNumber.toString(16)}`;
  const tip = await rpc(1, 'eth_call', [{ to: POOL, data: `0x${SEL.attestedReflectionTip}` }, block], { ttlMs: 24 * 3600_000, store: 'chain' });
  const height = await rpc(1, 'eth_call', [{ to: RELAY, data: `0x${SEL.blockHeight}${tip.slice(2)}` }, 'latest'], { ttlMs: 24 * 3600_000, store: 'chain' });
  return uint(height);
}

module.exports = { bridgeOnChain, recentPoolEvents, ethAssets, attestedAt, RELAY, CONFIRMATIONS, TOKENS };
