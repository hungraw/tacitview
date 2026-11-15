// Builds server/data/privacy-snapshot.json from Ethereum alone: every ConfidentialPool log since deploy and the
// calldata of each settle transaction (for lock spends, which emit no log), folded into the traced-spend state. The
// server reads newer blocks itself. At the end the totals are compared with Tacit's /confidential/index (one GET), as
// a check, not as a source.
//   node scripts/privacy-snapshot.mjs           only the blocks since the last snapshot (seconds)
//   node scripts/privacy-snapshot.mjs --full    every block since deploy (under 2 minutes)
// Old logs need an archive node: Tenderly's public gateway serves 100,000-block ranges, MEV Blocker 20,000 (publicnode
// and drpc stop at ~10,000 blocks back). MEV Blocker answers batches of 100 transaction lookups; Tenderly limits them.
// Blockscout's keyless API was tried first and blocked the IP for ~50 minutes after about a dozen large pages.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fold, emptyState, serialize, load } = require('../server/measured-privacy.cjs');
const { entriesFromLogs, txsNeedingInput, emptyCounts } = require('../server/pool-index.cjs');
const { POOL } = require('../server/pool-logs.cjs');
const { emptyChain, grow } = require('../server/tacit-chain.cjs');

const DEPLOY = 25_998_736;
const CONFIRM = 12; // blocks kept back from the head, so the snapshot never holds a block that can still reorg
const LOGS = [['https://gateway.tenderly.co/public/mainnet', 100_000], ['https://rpc.mevblocker.io', 20_000], ['https://gateway.tenderly.co/public/mainnet', 20_000]];
const TXS = ['https://rpc.mevblocker.io', 'https://eth.drpc.org'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (String(v).startsWith('0x') ? Number.parseInt(v, 16) : Number(v));
const hex = (n) => `0x${n.toString(16)}`;

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
  return res.json();
}
async function call(url, method, params) {
  const j = await post(url, { jsonrpc: '2.0', id: 1, method, params });
  if (j.error) throw new Error(`${new URL(url).host} ${method}: ${j.error.message}`);
  return j.result;
}

// One range of pool logs: each endpoint in turn, at its own span; a range larger than the span is split.
async function logsRange(from, to) {
  const errors = [];
  for (const [url, span] of LOGS) {
    try {
      const out = [];
      for (let a = from; a <= to; a += span) out.push(...await call(url, 'eth_getLogs', [{ address: POOL, fromBlock: hex(a), toBlock: hex(Math.min(a + span - 1, to)) }]));
      return out;
    } catch (error) { errors.push(error.message); await sleep(1_000); }
  }
  throw new Error(`logs ${from}-${to}: ${errors.join('; ')}`);
}

// Calldata for `hashes`: batches of 100, four in flight, each batch retried (on the next endpoint) until whole.
async function inputsOf(hashes) {
  const inputs = new Map();
  const batches = [];
  for (let i = 0; i < hashes.length; i += 100) batches.push(hashes.slice(i, i + 100));
  let next = 0, done = 0;
  async function worker() {
    while (next < batches.length) {
      const part = batches[next++];
      for (let k = 0; ; k += 1) {
        try {
          const url = TXS[k % TXS.length];
          const answers = await post(url, part.map((h, id) => ({ jsonrpc: '2.0', id, method: 'eth_getTransactionByHash', params: [h] })));
          if (!Array.isArray(answers)) throw new Error('not a batch reply');
          for (const a of answers) if (a?.result?.input) inputs.set(part[a.id], a.result.input);
          const gaps = part.filter((h) => !inputs.has(h));
          if (gaps.length) throw new Error(`${gaps.length} transactions not returned`);
          break;
        } catch (error) { if (k >= 7) throw error; await sleep(2_000 * (k + 1)); }
      }
      done += part.length;
      process.stdout.write(`\r  calldata: ${done.toLocaleString()} of ${hashes.length.toLocaleString()}   `);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  process.stdout.write('\n');
  return inputs;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const t0 = Date.now();
const tacit = await getJson('https://api.tacit.finance/confidential/index?limit=1').catch(() => null);
const head = num(await call('https://ethereum-rpc.publicnode.com', 'eth_blockNumber', [])) - CONFIRM;
// Build to the block Tacit's index has reached when it is close, so the comparison at the end is like for like.
const to = tacit?.indexedToBlock && tacit.indexedToBlock <= head && head - tacit.indexedToBlock < 50 ? tacit.indexedToBlock : head;
// An update starts from the shipped snapshot when it was built from Ethereum (an older one came from Tacit's index).
const old = process.argv.includes('--full') ? null : load();
const from = old?.source === 'ethereum' && old.nextBlock && old.counts && old.chain && old.mints ? old.nextBlock : DEPLOY;
console.log(`ConfidentialPool ${POOL}, blocks ${from.toLocaleString()} to ${to.toLocaleString()}${from === DEPLOY ? ' (full build)' : ' (update)'}`);

const logs = [];
for (let a = from; a <= to; a += 100_000) {
  logs.push(...await logsRange(a, Math.min(a + 99_999, to)));
  process.stdout.write(`\r  logs: block ${Math.min(a + 99_999, to).toLocaleString()} of ${to.toLocaleString()}, ${logs.length.toLocaleString()} logs   `);
}
process.stdout.write('\n');
const t1 = Date.now();
const inputs = await inputsOf(txsNeedingInput(logs));
console.log(`  logs ${Math.round((t1 - t0) / 1000)} s, calldata ${Math.round((Date.now() - t1) / 1000)} s`);

const counts = from === DEPLOY ? emptyCounts() : { ...emptyCounts(), ...old.counts };
const acc = {}; // Tacit chain block bodies and bridge mints (pool-index.cjs)
const entries = entriesFromLogs(logs, inputs, counts, undefined, acc);
const state = fold(from === DEPLOY ? emptyState() : old, entries);
state.chain = grow(from === DEPLOY ? emptyChain() : old.chain, acc.bodies || []);
state.mints = [...(from === DEPLOY ? [] : old.mints || []), ...(acc.mints || []).map((m) => [m.nullifier, m.tx, m.block])];
state.nextBlock = to + 1;
state.counts = counts;
delete state.nextSeq;
const out = new URL('../server/data/privacy-snapshot.json', import.meta.url);
fs.writeFileSync(out, `${JSON.stringify({ ...serialize(state), source: 'ethereum', madeAt: new Date().toISOString() })}\n`);
console.log(`${state.spends} spends, ${state.traced.lock + state.traced.bearer} traced (${state.traced.lock} lock, ${state.traced.bearer} bearer), through block ${to}, ${(fs.statSync(out).size / 1024).toFixed(0)} KB, ${Math.round((Date.now() - t0) / 1000)} s`);

// The check against Tacit's index (only like for like when both stop at the same block).
if (tacit?.counts) {
  const same = tacit.indexedToBlock === to;
  console.log(`Compared with Tacit's /confidential/index${same ? ` (both through block ${to})` : ` (Tacit through ${tacit.indexedToBlock}, ours through ${to}: small differences expected)`}:`);
  let ok = true;
  for (const k of Object.keys(counts)) {
    const theirs = tacit.counts[k];
    const match = theirs === counts[k];
    ok &&= match;
    console.log(`  ${k.padEnd(15)} ours ${String(counts[k]).padStart(6)}  Tacit ${String(theirs ?? '-').padStart(6)}  ${match ? 'match' : 'DIFFERENT'}`);
  }
  if (same && !ok) process.exitCode = 1;
}
// The Tacit chain and the bridge mints, against Tacit's own API (checks only).
const [pb, rs] = await Promise.all([getJson('https://api.tacit.finance/prover/blocks?limit=100').catch(() => null), getJson('https://api.tacit.finance/reflection/status').catch(() => null)]);
if (pb) {
  const ours = new Map(state.chain.blocks.map((b) => [b.height, b.hash]));
  const both = pb.blocks.filter((b) => ours.has(b.height));
  const same = both.filter((b) => ours.get(b.height) === b.hash.toLowerCase()).length;
  console.log(`Tacit chain: height ${state.chain.height}; ${same} of ${both.length} blocks Tacit also lists have the same hash${same === both.length ? '' : ' (DIFFERENT)'}`);
  if (same !== both.length) process.exitCode = 1;
}
if (rs) console.log(`Bridge mints: ${state.mints.length} (Tacit's bridgeMinted: ${rs.bridgeMinted})`);
