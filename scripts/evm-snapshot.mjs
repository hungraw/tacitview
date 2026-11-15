// Builds server/data/evm-snapshot.json.gz: every EVM pool deposit (block, sender, amount) and withdrawal (block,
// recipient, amount) since the pool was deployed on Ethereum, Base and Robinhood Chain. The server reads it at start
// and only reads the blocks after it live (server/evm-history.cjs).
//   node scripts/evm-snapshot.mjs            full build, about 20 minutes, mostly Base senders
//   node scripts/evm-snapshot.mjs --update   read only the blocks after the current snapshot (seconds to minutes),
//                                            run right before a deploy so cold instances have a short live tail
// Each chain also stores ~40 block-time anchors [block, unix seconds] from deploy to `through`, so the server dates any
// block by interpolation instead of stretching today's block speed back to deploy (Base's blocks were slower then).
// Sources, all free and keyless (measured 2026-11-13):
//   Ethereum: logs from Tenderly's public archive gateway in 50,000-block ranges (publicnode only serves logs ~10,000
//   blocks back; Blockscout's keyless API was used until it rate-limited this IP on 2026-11-15), senders from publicnode.
//   Base: base-rpc.publicnode.com, 50,000-block eth_getLogs windows from deploy.
//   Robinhood: rpc.mainnet.chain.robinhood.com, no range limit seen.
// Deposit senders are tx.from of each deposit transaction (100 per JSON-RPC batch). So are the senders of withdrawals
// with no relayer in the log: a wallet that withdraws itself is public as the transaction's sender.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
const CHAINS = {
  1: { rpc: 'https://ethereum-rpc.publicnode.com', logsRpc: 'https://gateway.tenderly.co/public/mainnet', deploy: 26_069_000, span: 50_000 },
  8453: { rpc: 'https://base-rpc.publicnode.com', deploy: 51_863_000, span: 50_000 },
  4663: { rpc: 'https://rpc.mainnet.chain.robinhood.com', deploy: 0, span: 5_000_000, batch: 20, pause: 500 },
};
const hex = (n) => `0x${n.toString(16)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body, tries = 8) {
  for (let i = 0; ; i += 1) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      if (i >= tries) throw error;
      await sleep(String(error.message).includes('429') ? 5_000 * (i + 1) : 1_000 * (i + 1)); // 429: back off longer
    }
  }
}
async function rpc(url, method, params, tries = 3) {
  for (let i = 0; ; i += 1) {
    const j = await post(url, { jsonrpc: '2.0', id: 1, method, params });
    if (!j.error) return j.result;
    if (i >= tries) throw new Error(`${method}: ${j.error.message}`);
    await sleep(2_000 * (i + 1)); // publicnode sometimes answers "internal filter error" once
  }
}

// One range of logs; a range that keeps failing is read as two halves.
async function logsRange(url, start, to) {
  try { return await rpc(url, 'eth_getLogs', [{ address: POOL, fromBlock: hex(start), toBlock: hex(to) }]); } catch (error) {
    if (to - start < 1_000) throw error;
    const mid = Math.floor((start + to) / 2);
    return [...await logsRange(url, start, mid), ...await logsRange(url, mid + 1, to)];
  }
}

// Transact log data words: [4] recipient, [5] extAmount (int256: >0 deposit, <0 withdrawal, 0 private transfer),
// [6] relayer (zero when the user's own wallet sends it).
function decode(l) {
  const w = l.data.slice(2).match(/.{64}/g) || [];
  let amount = BigInt(`0x${w[5] || '0'}`);
  if (amount >= 1n << 255n) amount -= 1n << 256n;
  return { block: Number.parseInt(l.blockNumber, 16), tx: l.transactionHash, amount, recipient: `0x${(w[4] || '').slice(24)}`, relayed: /[1-9a-f]/.test((w[6] || '').slice(24)) };
}

async function chainLogs(chain, head, from = CHAINS[chain].deploy) {
  const c = CHAINS[chain];
  const out = [];
  for (let start = from; start <= head; start += c.span) {
    const to = Math.min(start + c.span - 1, head);
    out.push(...await logsRange(c.logsRpc || c.rpc, start, to));
    process.stdout.write(`\r  ${chain}: block ${to.toLocaleString()} of ${head.toLocaleString()}, ${out.length.toLocaleString()} logs   `);
  }
  process.stdout.write('\n');
  return out;
}

async function senders(chain, hashes) {
  const map = new Map();
  const size = CHAINS[chain].batch || 100;
  for (let i = 0; i < hashes.length; i += size) {
    if (CHAINS[chain].pause) await sleep(CHAINS[chain].pause); // Robinhood's RPC answers 429 to back-to-back batches
    const batch = hashes.slice(i, i + size);
    const answer = await post(CHAINS[chain].rpc, batch.map((h, id) => ({ jsonrpc: '2.0', id, method: 'eth_getTransactionByHash', params: [h] })));
    for (const r of Array.isArray(answer) ? answer : []) if (r.result?.from) map.set(r.result.hash, r.result.from.toLowerCase());
    process.stdout.write(`\r  ${chain}: senders ${Math.min(i + size, hashes.length).toLocaleString()} of ${hashes.length.toLocaleString()}   `);
  }
  process.stdout.write('\n');
  const missing = hashes.filter((h) => !map.has(h));
  if (missing.length) throw new Error(`${chain}: ${missing.length} deposit senders not read`);
  return map;
}

// ~40 [block, time] pairs from the first event to `head`, evenly spaced (headers are served without an archive node).
async function anchors(chain, first, head) {
  const n = 40, blocks = [...new Set(Array.from({ length: n + 1 }, (_, i) => Math.round(first + ((head - first) * i) / n)))];
  const out = [];
  for (let i = 0; i < blocks.length; i += 20) {
    if (CHAINS[chain].pause) await sleep(CHAINS[chain].pause);
    const answer = await post(CHAINS[chain].rpc, blocks.slice(i, i + 20).map((b, id) => ({ jsonrpc: '2.0', id, method: 'eth_getBlockByNumber', params: [hex(b), false] })));
    for (const r of Array.isArray(answer) ? answer : []) if (r.result?.timestamp) out.push([Number.parseInt(r.result.number, 16), Number.parseInt(r.result.timestamp, 16)]);
  }
  if (out.length < 2) throw new Error(`${chain}: block-time anchors not read`);
  return out.sort((a, b) => a[0] - b[0]);
}

// Rows: { block, kind: 'dep' | 'wd', addr, amount (abs, string), by (withdrawals: sender or null), relayed }.
function rowsOf(events, from) {
  return events.filter((e) => e.amount !== 0n).map((e) => (e.amount > 0n
    ? { block: e.block, kind: 'dep', addr: from.get(e.tx), amount: e.amount.toString() }
    : { block: e.block, kind: 'wd', addr: e.recipient.toLowerCase(), amount: (-e.amount).toString(), relayed: e.relayed, by: e.relayed ? null : from.get(e.tx) }));
}
function unpackRows(c, raw) {
  const out = [];
  for (const [kind, cols] of [['dep', c.deposits], ['wd', c.withdrawals]]) {
    let block = 0;
    cols[0].forEach((d, i) => {
      block += d;
      const r = { block, kind, addr: raw.addrs[cols[1][i]], amount: raw.amounts[cols[2][i]] };
      if (kind === 'wd') { const by = cols[3]?.[i]; r.relayed = by === -1; r.by = by == null || by < 0 ? null : raw.addrs[by]; }
      out.push(r);
    });
  }
  return out;
}

const FILE = new URL('../server/data/evm-snapshot.json.gz', import.meta.url);
const update = process.argv.includes('--update');
const old = update ? JSON.parse(gunzipSync(readFileSync(FILE)).toString('utf8')) : null;
const addrs = [], addrIndex = new Map(), amounts = [], amountIndex = new Map();
const idx = (list, index, v) => { if (!index.has(v)) { index.set(v, list.length); list.push(v); } return index.get(v); };
const chains = {};
for (const chain of Object.keys(CHAINS)) {
  let head, rows;
  if (update) {
    const c = old.chains[chain];
    head = Number.parseInt(await rpc(CHAINS[chain].rpc, 'eth_blockNumber', []), 16) - 64;
    console.log(`chain ${chain}: blocks ${(c.through + 1).toLocaleString()} to ${head.toLocaleString()}`);
    const events = head > c.through ? (await chainLogs(chain, head, c.through + 1)).map(decode).filter((e) => e.block > c.through) : [];
    const from = await senders(chain, [...new Set(events.filter((e) => e.amount > 0n || (e.amount < 0n && !e.relayed)).map((d) => d.tx))]);
    rows = [...unpackRows(c, old), ...rowsOf(events, from)];
    console.log(`  +${events.length.toLocaleString()} events`);
  } else {
    // A finished chain is kept in the temp folder for an hour, so a failure on a later chain does not redo it.
    const checkpoint = join(tmpdir(), `tacit-evm-snapshot-${chain}.json`);
    let events, from;
    const saved = existsSync(checkpoint) ? JSON.parse(readFileSync(checkpoint, 'utf8')) : null;
    if (saved && saved.v === 2 && Date.now() - saved.at < 3600_000) {
      head = saved.head; events = saved.events.map((e) => ({ ...e, amount: BigInt(e.amount) })); from = new Map(saved.from);
      console.log(`chain ${chain}: from checkpoint, block ${head.toLocaleString()}`);
    } else {
      head = Number.parseInt(await rpc(CHAINS[chain].rpc, 'eth_blockNumber', []), 16) - 64;
      console.log(`chain ${chain}: logs to block ${head.toLocaleString()}`);
      events = (await chainLogs(chain, head)).map(decode).sort((a, b) => a.block - b.block);
      from = await senders(chain, [...new Set(events.filter((e) => e.amount > 0n || (e.amount < 0n && !e.relayed)).map((d) => d.tx))]);
      writeFileSync(checkpoint, JSON.stringify({ v: 2, at: Date.now(), head, events: events.map((e) => ({ ...e, amount: e.amount.toString() })), from: [...from] }));
    }
    rows = rowsOf(events, from);
  }
  rows.sort((a, b) => a.block - b.block);
  // Column arrays, blocks delta-encoded: [blockDelta[], address[], amount[]]; withdrawals add a fourth column, the
  // sending wallet's address index, or -1 when a relayer sent it.
  const pack = (list, wd) => {
    let prev = 0; const b = [], a = [], v = [], s = [];
    for (const r of list) {
      b.push(r.block - prev); prev = r.block; a.push(idx(addrs, addrIndex, r.addr)); v.push(idx(amounts, amountIndex, r.amount));
      if (wd) s.push(r.relayed ? -1 : idx(addrs, addrIndex, r.by));
    }
    return wd ? [b, a, v, s] : [b, a, v];
  };
  const deposits = rows.filter((r) => r.kind === 'dep'), withdrawals = rows.filter((r) => r.kind === 'wd');
  chains[chain] = { through: head, anchors: await anchors(chain, rows[0]?.block ?? head - 1, head), deposits: pack(deposits, false), withdrawals: pack(withdrawals, true) };
  console.log(`  ${deposits.length.toLocaleString()} deposits, ${withdrawals.length.toLocaleString()} withdrawals, ${chains[chain].anchors.length} time anchors`);
}
const json = JSON.stringify({ builtAt: new Date().toISOString(), pool: POOL, addrs, amounts, chains });
writeFileSync(FILE, gzipSync(json, { level: 9 }));
console.log(`wrote ${(json.length / 1e6).toFixed(1)} MB json, ${addrs.length.toLocaleString()} addresses, ${amounts.length.toLocaleString()} amounts`);
