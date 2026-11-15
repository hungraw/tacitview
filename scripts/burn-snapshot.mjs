// Builds server/data/burn-snapshot.json: every bridge burn on Bitcoin since Tacit's first block (948,242, its first
// asset etch; a burn can predate the ConfidentialPool and be minted later), read from the raw blocks and decoded here: txid, height, time, asset and the burn's
// nullifier, which its Ethereum mint spends. The server adds the burns in its decoded block window on top. Envelopes are
// read where Tacit's reflection guest reads them (witness item 1, envelope.cjs envelopeItems).
//   node scripts/burn-snapshot.mjs            only the blocks after the current snapshot
//   node scripts/burn-snapshot.mjs --full     every block since Tacit's first (~27,700 raw blocks, ~40 GB)
// Speed: ten Esplora hosts, 24 blocks in flight, each sent to whichever host is quickest at that moment; a host that
// answers 429 rests for a while on its own. Decoded blocks are kept in a resume file, so an interrupted full scan carries on where it stopped.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decodeBlock } = require('../server/btc-block.cjs');
const { decodeTx } = require('../server/envelope.cjs');
const { POOL_BINDING } = require('../server/pool-logs.cjs');
const LAUNCH = 948_242;
const CONFIRM = 6; // blocks kept back from the tip, so a reorg cannot change a block in the snapshot
// The site's four Esplora hosts plus public mempool instances and mempool.space's regional mirrors, used only by this
// one-off scan.
const HOSTS = ['https://mempool.bitaroo.net/api', 'https://bitcoin.lu.ke/api', 'https://mempool.tk7.mempool.space/api', 'https://mempool.emzy.de/api',
  'https://mempool.sg1.mempool.space/api', 'https://mempool.fra.mempool.space/api', 'https://mempool.va1.mempool.space/api', 'https://mempool.ninja/api',
  'https://mempool.space/api', 'https://blockstream.info/api'];
const SLOTS = 24; // raw blocks in flight in total (48 drew 429s from most hosts and ran slower)
const PER_HOST_MAX = 4;
const OUT = new URL('../server/data/burn-snapshot.json', import.meta.url);
const RESUME = join(tmpdir(), 'tacitview-burn-scan.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each request goes to the host that is quickest right now: the lowest (requests in flight + 1) × recent seconds per
// block, among hosts not resting. A slow host gets little work instead of holding slots; a 429 rests a host for 30 s.
const rest = new Map(); // host -> time it may be used again
const stat = new Map(HOSTS.map((h) => [h, { inflight: 0, ewma: 3_000 }]));
function pickHost() {
  let best = null, bestScore = Infinity;
  for (const h of HOSTS) {
    const st = stat.get(h);
    if ((rest.get(h) || 0) > Date.now() || st.inflight >= PER_HOST_MAX) continue;
    const score = (st.inflight + 1) * st.ewma;
    if (score < bestScore) { best = h; bestScore = score; }
  }
  return best;
}
async function get(path, kind) {
  for (let attempt = 0; attempt < 400; attempt += 1) { // a busy minute of 429s waits instead of ending the scan
    const host = pickHost();
    if (!host) { await sleep(500); continue; }
    const st = stat.get(host);
    st.inflight += 1;
    const t = Date.now();
    try {
      const res = await fetch(host + path, { signal: AbortSignal.timeout(kind === 'raw' ? 45_000 : 15_000) });
      if (res.status === 429 || res.status >= 500) { rest.set(host, Date.now() + (res.status === 429 ? 30_000 : 10_000)); continue; }
      if (!res.ok) throw new Error(`${host}${path} HTTP ${res.status}`);
      const out = kind === 'raw' ? Buffer.from(await res.arrayBuffer()) : await res.json();
      if (kind === 'raw') st.ewma = st.ewma * 0.7 + (Date.now() - t) * 0.3;
      return out;
    } catch (error) {
      if (/HTTP 4/.test(error.message)) throw error;
      rest.set(host, Date.now() + 5_000);
      st.ewma *= 1.5;
    } finally { st.inflight -= 1; }
  }
  throw new Error(`no host answered ${path}`);
}

const old = !process.argv.includes('--full') && existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
const from = old ? old.through + 1 : LAUNCH;
const tip = Number(await (await fetch(`${HOSTS[0]}/blocks/tip/height`)).text());
const to = tip - CONFIRM;
const t0 = Date.now();
console.log(`Bitcoin blocks ${from.toLocaleString()} to ${to.toLocaleString()} (${(to - from + 1).toLocaleString()} blocks)`);

// Heights to hashes and times: 10 per /blocks call.
const heads = new Map();
const starts = [];
for (let h = to; h >= from; h -= 10) starts.push(h);
let si = 0;
await Promise.all(Array.from({ length: SLOTS }, async () => {
  while (si < starts.length) { const h = starts[si++]; for (const b of await get(`/blocks/${h}`, 'json')) if (b.height >= from && b.height <= to) heads.set(b.height, { hash: b.id, time: b.timestamp }); }
}));

// Blocks decoded by an earlier, interrupted run of the same scan.
const done = new Map();
if (existsSync(RESUME)) for (const line of readFileSync(RESUME, 'utf8').split('\n')) { try { const r = JSON.parse(line); if (heads.get(r.height)?.hash === r.hash) done.set(r.height, r); } catch { /* partial line */ } }
const todo = [...heads.keys()].filter((h) => !done.has(h)).sort((a, b) => a - b);
console.log(`  ${done.size.toLocaleString()} blocks already decoded, ${todo.length.toLocaleString()} to read`);
let ti = 0, bytes = 0, n = 0;
await Promise.all(Array.from({ length: SLOTS }, async () => {
  while (ti < todo.length) {
    const height = todo[ti++];
    const { hash, time } = heads.get(height);
    const raw = await get(`/block/${hash}/raw`, 'raw');
    const block = decodeBlock(raw);
    if (block.hash !== hash) throw new Error(`block ${height}: hash mismatch`);
    const burns = block.envelopes.filter((e) => e.name === 'bridge burn').map((e) => ({ txid: e.txid, height, time, assetId: e.assetId || null, nullifier: e.nullifier || null, binding: e.binding || null }));
    const row = { height, hash, burns };
    done.set(height, row);
    appendFileSync(RESUME, `${JSON.stringify(row)}\n`);
    bytes += raw.length; n += 1;
    if (n % 100 === 0) { const s = (Date.now() - t0) / 1000; console.log(`  ${(done.size).toLocaleString()} of ${heads.size.toLocaleString()} blocks, ${(bytes / 1e9).toFixed(2)} GB, ${(bytes / 1e6 / s).toFixed(1)} MB/s, ~${Math.round(((todo.length - n) * s) / n / 60)} min left`); }
  }
}));
process.stdout.write('\n');

const burns = [...(old?.burns || []), ...[...done.values()].filter((r) => r.height >= from).flatMap((r) => r.burns)].sort((a, b) => a.height - b.height || a.txid.localeCompare(b.txid));
// Burns decoded before the binding was kept: read it from each transaction (small JSON requests).
const unbound = burns.filter((b) => !b.binding);
let bi = 0;
await Promise.all(Array.from({ length: 8 }, async () => { while (bi < unbound.length) { const b = unbound[bi++]; const e = decodeTx(await get(`/tx/${b.txid}`, 'json')); b.binding = e?.binding || null; } }));
if (unbound.length) console.log(`  read the target deployment of ${unbound.length} earlier burns`);
writeFileSync(OUT, `${JSON.stringify({ through: to, launch: LAUNCH, binding: POOL_BINDING, madeAt: new Date().toISOString(), burns })}\n`);
const mine = burns.filter((b) => b.binding === POOL_BINDING).length;
console.log(`${burns.length} bridge burns through block ${to}, ${mine} of them for this pool (binding ${POOL_BINDING.slice(0, 12)}…), ${Math.round((Date.now() - t0) / 1000)} s`);
const st = await fetch('https://api.tacit.finance/reflection/status').then((r) => r.json()).catch(() => null);
if (st) console.log(`Tacit's /reflection/status (a check, not a source): ${st.bridgeBurns} burns, ${st.bridgeMinted} minted`);
