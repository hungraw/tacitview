// Offline checks (no network, about 0.3 s). Only behaviour that would hurt users or correctness if it broke: the
// proxy's security boundary, the privacy promises, the protocol decoders against real mainnet bytes, the pool and
// withdrawal-check rules, input routing, money formatting and the caches. Expected values come from an independent
// source wherever there is one (Tacit's published hashes and index, known test vectors, an Ethereum node), never from
// running the code under test. test/mutants.mjs plants bugs to check that these tests notice.
const assert = require('node:assert/strict');
const { test } = require('node:test');
// Offline means offline: any network call fails at once. (The Vercel entry's first request starts the server's
// warm-up; with this it ends in milliseconds instead of downloading blocks for 20 s.)
globalThis.fetch = async (url) => { throw new Error(`offline test reached the network: ${String(url).slice(0, 80)}`); };
const { apiHandler } = require('../server/api-handler.cjs');
const { decodeTx } = require('../server/envelope.cjs');
const { decodeTacitAddress, encodeBech32m } = require('../server/tacit-address.cjs');
const { classifyQuery } = require('../server/footprint.cjs');
const { cached } = require('../server/upstream.cjs');

function call(url, method = 'GET') {
  return new Promise((resolve) => {
    const res = { writeHead(status, headers = {}) { this.status = status; this.headers = headers; }, end() { resolve(this); } };
    apiHandler({ url, method }, res);
  });
}

test('proxy forwards only allowlisted GET routes', async () => {
  for (const url of ['/api/admin/x', '/api/debug', '/api/recent/../admin', '/api/%2e%2e/admin', '/api/stats', '/api/views/constructor']) {
    assert.equal((await call(url)).status, 404, url);
  }
  const post = await call('/api/recent', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET');
});

test('Vercel entry loads as ESM and production headers match the dev server', async () => {
  // The package is "type": "module"; a CommonJS entry would crash on Vercel. The rewrite must restore the URL.
  const { default: handler, originalUrl } = await import('../api/proxy.js');
  assert.equal(originalUrl('/api/proxy?path=views/footprint&q=vitalik%40eth'), '/api/views/footprint?q=vitalik%40eth');
  assert.equal(originalUrl('/api/proxy?path=assets&network=mainnet'), '/api/assets?network=mainnet');
  const res = await new Promise((resolve) => {
    const r = { writeHead(status) { this.status = status; }, end() { resolve(this); } };
    handler({ url: '/api/proxy?path=admin', method: 'GET' }, r);
  });
  assert.equal(res.status, 404);
  const { SECURITY_HEADERS } = require('../server/security-headers.cjs');
  const vercel = Object.fromEntries(require('../vercel.json').headers[0].headers.map(({ key, value }) => [key, value]));
  assert.deepEqual(vercel, SECURITY_HEADERS);
});

test('envelope decoder reads a real mainnet confidential transfer', () => {
  // f46f0e32… on mainnet: TAC transfer, one note. Payload 98 + 41×1 + 2 + 591 = 732 bytes.
  const tx = require('./fixtures/cxfer-tx.json');
  const e = decodeTx(tx);
  assert.equal(e.name, 'T_CXFER_BPP');
  assert.equal(e.assetId, 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b');
  assert.equal(e.outputs, 1);
  assert.equal(decodeTx({ vin: [{ witness: ['aa'] }] }), null, 'key-path spend has no envelope');
});

test('ENS namehash and name routing', () => {
  const { namehash, systemFor } = require('../server/names.cjs');
  assert.equal(namehash('eth'), '93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae');
  assert.deepEqual(['a.eth', 'a.wei', 'a.gwei', 'a.base.eth', 'a@b'].map((n) => systemFor(n).system), ['ens', 'wns', 'gns', 'base', 'xns']);
});

test('opcode names follow SPEC.md, including the 161-byte bridge burn', () => {
  // The first hand-written table had six names wrong (0x2A, 0x2C, 0x36, 0x3D, 0x3E, 0x5C); these come from the spec tables.
  const { decodeLeafScript } = require('../server/envelope.cjs');
  const env = (code, bytes) => decodeLeafScript(`00630554414349540101${bytes <= 75 ? bytes.toString(16).padStart(2, '0') : '4c' + bytes.toString(16).padStart(2, '0')}${code}${'00'.repeat(bytes - 1)}68`);
  assert.equal(env('26', 10).name, 'T_AXFER');
  assert.equal(env('2a', 10).name, 'T_WITHDRAW');
  assert.equal(env('2b', 161).name, 'bridge burn');
  assert.equal(env('2b', 40).name, 'T_DROP');
  assert.equal(env('45', 10).name, 'cBTC.zk slot');
  assert.equal(env('6a', 10).name, null, 'free opcode stays unnamed');
});

test('tacit address decoder accepts a real address and rejects bad ones', () => {
  // Built from three random secp256k1 public keys (private keys discarded, never funded), flags 0x03.
  const addr = 'tacit1qqpsx7l42csv089rxthxphs9ak60k88uxvjuedxth6mnh8gpvg20fzs9qwag5gsjff24wmn8a87huw8qqa277skk4h6scp30lucp0nfsvqgggqek9lwmtnmwuerfvrp0yvc5h0c33uluyuu6gnd7nx7aqd97zreelgmazmjd';
  const ok = decodeTacitAddress(addr);
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.network, 'mainnet');
  assert.equal(decodeTacitAddress(addr.slice(0, -1) + (addr.endsWith('q') ? 'p' : 'q')).error, 'checksum mismatch');
  const scan = [...Buffer.from(ok.keys['Bitcoin scan key'], 'hex')];
  const evm = [...Buffer.from(ok.keys['Ethereum-side key'], 'hex')];
  assert.match(decodeTacitAddress(encodeBech32m('tacit', [0, 3, 0x02, ...Array(32).fill(0xff), ...scan, ...evm])).error, /not a valid secp256k1 point/);
});

test('lookup input routing', () => {
  const cases = [
    ['F'.repeat(64), 'btc-txid-or-asset'], ['0x' + 'a'.repeat(64), 'eth-tx'], [' 0x' + 'A'.repeat(40) + ' ', 'evm-address'],
    ['0x' + 'a'.repeat(39), 'unknown'], // a mistyped address must not be treated as a name (real bug, fixed)
    ['vitalik@eth', 'name'], ['vitalik.eth', 'name'], ['z0r0z.wei', 'name'], ['TAC', 'name-or-ticker'], ['tacit1' + 'q'.repeat(20), 'tacit-address'], ['hello there', 'unknown'],
  ];
  for (const [input, kind] of cases) assert.equal(classifyQuery(input).kind, kind, input);
});

test('amounts are truncated, never rounded up', async () => {
  const { formatUnits } = await import('../src/format.js');
  assert.equal(formatUnits('7881650442957887592', 18, 4), '7.8816');
  assert.equal(formatUnits('308693773153451798938226', 18, 2), '308,693.77');
});

test('cache serves the last good value when the upstream fails', async () => {
  let calls = 0;
  const [a, b] = await Promise.all([cached('t', async () => ++calls, { ttlMs: 0 }), cached('t', async () => ++calls, { ttlMs: 0 })]);
  assert.equal(calls, 1, 'concurrent requests share one upstream call');
  assert.equal(a.data, b.data);
  const stale = await cached('t', async () => { throw new Error('down'); }, { ttlMs: 0 });
  assert.equal(stale.stale, true);
  await assert.rejects(cached('never-loaded', async () => { throw new Error('down'); }));
});

test('routes and search go to the right page', async () => {
  const { routeForQuery, parseRoute } = await import('../src/router.js');
  assert.equal(routeForQuery(' 0x' + 'AB'.repeat(32)), '#/eth/0x' + 'ab'.repeat(32));
  assert.equal(routeForQuery('975146'), '#/block/975146');
  assert.equal(routeForQuery('vitalik@eth'), '#/address/vitalik%40eth');
  assert.equal(routeForQuery('Z0r0z.wei'), '#/address/z0r0z.wei');
  assert.equal(routeForQuery('TAC'), '#/search/TAC');
  assert.deepEqual(parseRoute('#/tx/' + 'f'.repeat(64)), { kind: 'detail', name: 'tx', id: 'f'.repeat(64), view: 'btc-tx' });
  assert.equal(parseRoute('#/tx/nothex').kind, 'invalid');
  assert.deepEqual(parseRoute('#/'), { kind: 'live', page: 'home' });
  assert.deepEqual(parseRoute('#/bitcoin'), { kind: 'live', page: 'bitcoin' });
  assert.deepEqual(parseRoute('#/tacit-chain'), { kind: 'list', name: 'tacit-chain', view: 'chain-list', id: '' });
  assert.equal(parseRoute('#/tacit-chain/10390').id, '10390');
  assert.equal(parseRoute('#/address/vitalik%40eth').id, 'vitalik@eth');
  assert.equal(parseRoute('#/nowhere').kind, 'invalid');
  // Bitcoin addresses (bech32 lowercased, base58 kept as typed) and tacit1 addresses open address pages.
  assert.equal(routeForQuery(' BC1Q39E7P3JY977L50NJXP2MH3CPZR375PGHEYCXQX '), '#/address/bc1q39e7p3jy977l50njxp2mh3cpzr375pgheycxqx');
  assert.equal(routeForQuery('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'), '#/address/3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy');
  assert.equal(parseRoute('#/address/bc1q39e7p3jy977l50njxp2mh3cpzr375pgheycxqx').view, 'btc-address');
  assert.equal(parseRoute('#/address/vitalik.eth').view, 'footprint');
  assert.equal(routeForQuery('TACIT1' + 'Q'.repeat(20)), `#/address/tacit1${'q'.repeat(20)}`);
});

test('Keccak-256 matches known vectors, in the server and in the browser code', async () => {
  const { keccak256 } = require('../server/keccak.cjs');
  const browser = await import('../src/verify-block.js');
  const both = (bytes) => [keccak256(Buffer.from(bytes)).toString('hex'), browser.toHex(browser.keccak256(Uint8Array.from(bytes))).slice(2)];
  assert.deepEqual(both([]), Array(2).fill('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'));
  assert.deepEqual(both(Buffer.from('transfer(address,uint256)')).map((h) => h.slice(0, 8)), ['a9059cbb', 'a9059cbb']);
  // Around the 136-byte block size, where padding moves to a second block (vectors from an Ethereum node's web3_sha3).
  assert.deepEqual(both(Buffer.alloc(135, 0x61)), Array(2).fill('34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446'));
  assert.deepEqual(both(Buffer.alloc(136, 0x61)), Array(2).fill('a6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e'));
});

test('asset icons only accept asset ids', async () => {
  const { assetIcon } = require('../server/asset-icon.cjs');
  for (const bad of ['', 'zz', '../etc', 'https://example.com/x.png', 'a'.repeat(63)]) assert.equal(await assetIcon(bad), null);
});

test('a Tacit chain block that spends a lock note hashes with its lock nullifier (block 10538)', () => {
  const { blockHash } = require('../server/chain-verify.cjs');
  const block = { prev: '0x4717fd8f6fa4fb7c65964164ad190e37e6d32db3a509f6a81468e4778698f10a', height: 10538, ethBlock: 26383430, tx: '0x0cce9dfb9ecf81c591d8eef1fe1e18897f4cd9bbd58ce8f89ce35ae10ce67663', leaves: ['0x15c16a5561ed11246c65d82756bcbd903e6a8310e31c83c5386c06a10011a361'] };
  assert.equal(blockHash({ ...block, nullifiers: ['0x0121d9af6edca90a27016bbcde6fad8493a1905162e4078e122f184fd98b4354'] }), '0xf90df26e0d8eadd8a5efc6b3174c1b3db8cf045c47740a5cbc233c8c2ce67cfe');
  assert.notEqual(blockHash({ ...block, nullifiers: [] }), '0xf90df26e0d8eadd8a5efc6b3174c1b3db8cf045c47740a5cbc233c8c2ce67cfe');
});

test('index.html preloads every module main.js reaches (node scripts/modulepreload.mjs --write)', async () => {
  const { moduleGraph, preloadBlock } = await import('../scripts/modulepreload.mjs');
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes(preloadBlock(moduleGraph())), 'modulepreload list is stale: run node scripts/modulepreload.mjs --write');
  const { earlyScript } = await import('../scripts/modulepreload.mjs');
  assert.equal(require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/early.js'), 'utf8'), await earlyScript(), 'src/early.js is stale: run node scripts/modulepreload.mjs --write');
  // The inline stylesheet and early.js in index.html are the current files, and the CSP allows exactly them.
  const { inlineBlocks } = await import('../scripts/modulepreload.mjs');
  const { style, script, hashes } = inlineBlocks();
  assert.ok(html.includes(style) && html.includes(script), 'inline CSS or early.js in index.html is stale: run node scripts/modulepreload.mjs --write');
  assert.deepEqual(require('../server/inline-hashes.json'), hashes);
});

test('a Tacit address gives the same plain Bitcoin address as the wallet (P2WPKH of the spend key)', () => {
  const { p2wpkhAddress } = require('../server/tacit-address.cjs');
  assert.equal(p2wpkhAddress(Buffer.from('03440cca1affe3fbb338e53262bc9f9e5fd1ebd48cfe5ed52bd3a5b0ad7500a516', 'hex'), 'mainnet'), 'bc1qel5autl0ff4z47yfegk5y0r0arda5xw39qstgs');
});

test('filter bars drop empty options and single-option groups, and escape labels', async () => {
  const { filterBar } = await import('../src/filters.js');
  const html = filterBar('t', { groups: [
    { name: 'a', label: 'A "<i>', options: [['x', 'X <b>', 3], ['y', 'Y', 0], ['z', 'Z', 2]] },
    { name: 'b', label: 'B', options: [['only', 'Only', 5]] },
  ] });
  assert.match(html, /data-v="x"/);
  assert.doesNotMatch(html, /data-v="y"/); // no rows: no chip
  assert.doesNotMatch(html, /data-group="b"/); // one option is not a choice
  assert.match(html, /X &lt;b&gt;/);
  assert.match(html, /aria-label="A &quot;&lt;i&gt;"/);
  assert.doesNotMatch(html, /<i>|X <b>/);
  assert.equal(filterBar('t', { groups: [{ name: 'b', label: 'B', options: [['only', 'Only', 5]] }] }), '');
});

test('partial answers expire within seconds and are not stored', async () => {
  const { cachedJson } = await import('../src/data/cache.js');
  let calls = 0;
  const load = async () => { calls++; return { partial: true }; };
  await cachedJson('partial-test', load, { ttlMs: 60_000 });
  await cachedJson('partial-test', load, { ttlMs: 60_000 });
  assert.equal(calls, 1); // still fresh right after
  const realNow = Date.now; Date.now = () => realNow() + 5_000;
  try { await cachedJson('partial-test', load, { ttlMs: 60_000 }); } finally { Date.now = realNow; }
  assert.equal(calls, 2); // asked again after ~4s, not 60s
});

test('lookups are limited per visitor', async () => {
  const { overLimit } = require('../server/api-handler.cjs');
  const req = { headers: { 'x-real-ip': '203.0.113.9' } };
  let blocked = 0;
  for (let i = 0; i < 310; i++) if (overLimit(req)) blocked++;
  assert.equal(blocked, 10);
  assert.equal(overLimit({ headers: { 'x-real-ip': '203.0.113.10' } }), 0); // another visitor is not affected
});

test('server cache answers from an expired entry while it refreshes, within swrMs only', async () => {
  const { createCache } = require('../server/upstream.cjs');
  const cache = createCache(10);
  let n = 0;
  const load = async () => { n++; await new Promise((r) => setTimeout(r, 30)); return n; };
  await cache('k', load, { ttlMs: 10, swrMs: 1000 });
  await new Promise((r) => setTimeout(r, 20)); // expired, inside the swr window
  const quick = await cache('k', load, { ttlMs: 10, swrMs: 1000 });
  assert.deepEqual([quick.data, quick.stale], [1, true]); // old value at once
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await cache('k', load, { ttlMs: 1000, swrMs: 1000 })).data, 2); // refreshed in the background
});

test('RPC calls made together go out as one batch, and errors stay per call', async () => {
  const { sendBatch } = require('../server/rpc.cjs');
  let bodies = [];
  const fetchImpl = async (url, opts) => { bodies.push(JSON.parse(opts.body)); return { ok: true, json: async () => [{ id: 0, result: '0x1' }, { id: 1, error: { message: 'execution reverted' } }] }; };
  const out = await new Promise((done) => {
    const res = [];
    const item = (i) => ({ method: 'eth_call', params: [i], resolve: (v) => { res[i] = v; if (res.filter((x) => x !== undefined).length === 2) done(res); }, reject: (e) => { res[i] = e.message; if (res.filter((x) => x !== undefined).length === 2) done(res); } });
    sendBatch(1, [item(0), item(1)], fetchImpl);
  });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].length, 2);
  assert.equal(out[0], '0x1');
  assert.match(out[1], /execution reverted/);
});

test('the browser check re-hashes a Tacit chain block from raw Ethereum data, lock nullifier included (block 10538)', async () => {
  const { verifyBlock } = await import('../src/verify-block.js');
  const raw = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures/chain-10538.json'), 'utf8'));
  const r = verifyBlock(raw);
  assert.equal(r.nullifiers.lock.length, 1); // read from the settle calldata, not a log
  assert.ok(r.match, `computed ${r.computed}`);
  assert.ok(r.receiptMatches);
  assert.equal(verifyBlock({ ...raw, published: { ...raw.published, hash: '0x' + '00'.repeat(32) } }).match, false);
});

// ---- Fixtures from mainnet bytes (2026-11-13) ----

test('settle calldata decodes to the batch the contract applied (withdrawal 0x0e6c…ae8b)', () => {
  const { decodeSettle } = require('../server/settle-decode.cjs');
  const { input } = require('./fixtures/settle-0x0e6c.json');
  const s = decodeSettle(input);
  assert.equal(s.batches, 1);
  assert.equal(s.nullifiers, 1, 'one note spent, as its NullifiersSpent log shows');
  assert.equal(s.leaves, 0);
  assert.equal(s.withdrawals.length, 1);
  assert.equal(s.withdrawals[0].recipient, '0x1503d72f8d02396213133b73f2a78814fd272a4d');
  assert.equal(s.withdrawals[0].value, '786416393853', 'in-system units: 7,864.16 TAC at 8 decimals, paid as 7,864.16 TAC (18) by its Transfer');
  assert.equal(s.fees.length, 1);
  assert.equal(s.fees[0].value, '1200000000');
  assert.equal(decodeSettle('0x12345678'), null, 'not a settle call');
});

test('a bridge burn envelope carries its nullifier at bytes 65–96 (burn fe75a8…a92f)', () => {
  const tx = require('./fixtures/bridge-burn-fe75a8.json');
  const e = decodeTx(tx);
  assert.equal(e.name, 'bridge burn');
  assert.equal(e.payloadBytes, 161);
  assert.equal(e.assetId, 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', 'TAC');
  assert.match(e.nullifier, /^d614c7b8c5ac[0-9a-f]{52}$/);
});

test('a spend is traced when its nullifier is keccak(leaf ‖ "spent"): a real bearer pair from the pool index', () => {
  const { fold, emptyState } = require('../server/measured-privacy.cjs');
  // From /confidential/index (mainnet): leaf inserted by 0xf03a…cee1, spent by 0xb4a1…4908 with this nullifier.
  const leaf = '0xf93c20be92924745aac43e96074a5142bb832d4ab4bf62f1a37d8bf49b6f220c';
  const nullifier = '0x7423c5531882b6158189395dadefdab7089454a5bb764adabd1123576e5ebf11';
  const made = '0xf03ab46da94602ee6d3383ca9ab8228ace324bdeff01128d8d0fbb984e76cee1', spent = '0xb4a1f32d80ff1cd413d58023811eaafa8aed3388d3fa82741f52f06afa7d4908';
  const state = fold(emptyState(), [
    { seq: 0, block: 26017574, tx: made, leaves: [leaf] },
    { seq: 1, block: 26017693, tx: spent, nullifiers: [nullifier, `0x${'11'.repeat(32)}`], lockNullifiers: [`0x${'22'.repeat(32)}`] },
  ]);
  assert.equal(state.spends, 3);
  assert.equal(state.traced.bearer, 1, 'the real nullifier matches its leaf');
  assert.equal(state.traced.lock, 0, 'an unrelated lock nullifier is not traced');
  assert.deepEqual(state.pairs, [{ lock: false, made, madeBlock: 26017574, spent, spentBlock: 26017693 }]);
});

test('pool index rebuilt from chain data agrees with Tacit\'s index on 2 real transactions', () => {
  // Raw pool logs and calldata from mainnet (fixtures/pool-txs.json). The expected values are Tacit's own
  // /confidential/index entries for the same transactions, an independent decoder: 0x62dd… inserted 1 note leaf and
  // spent lock 0xabd591…, which emits no log and is only in the settle calldata; 0xa908… is 1 wrap and nothing else.
  const { entriesFromLogs, emptyCounts } = require('../server/pool-index.cjs');
  const fx = require('./fixtures/pool-txs.json');
  const LOCK = '0x62dd4bea1931d9db16bf773c2d2d68674f774f72d653b9fa652390babd3f6be8', WRAP = '0xa9085cb5a77f248bf7d4dbed352a05b0f4a401febebf3cedb829dbfc06cb7bfe';
  const logs = [...fx[LOCK].logs, ...fx[WRAP].logs];
  const counts = emptyCounts();
  // Only the settle transaction's calldata is given: a wrap with no note logs must not need any.
  const entries = entriesFromLogs(logs, new Map([[LOCK, fx[LOCK].input]]), counts);
  assert.deepEqual(counts, { leaves: 1, nullifiers: 0, wraps: 1, crossOuts: 0, lockLeaves: 0, lockNullifiers: 1 });
  assert.deepEqual(entries.flatMap((e) => e.lockNullifiers || []), ['0xabd59130129a1e5236139b836c3c1fddcc0437328b8e9fc5eb41edf8bed4a43c']);
  // The same calldata beside an unrelated note log: that settle call did not run in this transaction, so its lock
  // nullifier must not be counted.
  const leaf = require('../server/pool-logs.cjs').decodePoolLogs({ logs: fx[LOCK].logs })[0].leaves[0].slice(2);
  const other = { ...fx[LOCK].logs[0], data: fx[LOCK].logs[0].data.replace(leaf, '11'.repeat(32)) };
  assert.notEqual(other.data, fx[LOCK].logs[0].data);
  assert.deepEqual(entriesFromLogs([other], new Map([[LOCK, fx[LOCK].input]])).flatMap((e) => e.lockNullifiers || []), []);
  // Calldata that could not be read is an error, never "no lock spends".
  assert.throws(() => entriesFromLogs(fx[LOCK].logs, new Map()), /calldata missing/);
});

test('Tacit chain block rebuilt from Ethereum data gets the hash Tacit published (block 10538), and a wrap alone is no block', () => {
  // fixtures/chain-10538.json: the anchoring transaction's raw receipt and calldata, and the block Tacit published.
  // Its body comes out of the same pool index the site uses, and is chained onto Tacit's block 10537.
  const { entriesFromLogs } = require('../server/pool-index.cjs');
  const { extend } = require('../server/tacit-chain.cjs');
  const raw = require('./fixtures/chain-10538.json');
  const p = raw.published;
  const logs = raw.receipt.logs.map((l) => ({ ...l, blockNumber: raw.receipt.blockNumber, transactionHash: p.tx }));
  const acc = {};
  entriesFromLogs(logs, new Map([[p.tx.toLowerCase(), raw.input]]), undefined, undefined, acc);
  assert.equal(acc.bodies.length, 1);
  const e = extend({ height: p.height - 1, hash: p.prev }, acc.bodies);
  assert.deepEqual([e.height, e.hash], [p.height, p.hash]);
  // Two consecutive blocks (fixtures/chain-pair.json, heights 12328 and 12329) chained from Tacit's parent of the first:
  // both must come out with the heights and hashes Tacit published.
  const pair = require('./fixtures/chain-pair.json');
  const two = {};
  entriesFromLogs(pair.flatMap((x) => x.logs), new Map(pair.map((x) => [x.published.tx.toLowerCase(), x.input])), undefined, undefined, two);
  const made = extend({ height: pair[0].published.height - 1, hash: pair[0].published.prev }, two.bodies).made;
  assert.deepEqual(made.map((x) => [x.height, x.hash]), pair.map((x) => [x.published.height, x.published.hash]));
  // fixtures/pool-txs.json: 0xa908… only wrapped a deposit, which Tacit's chain does not count as a block.
  const fx = require('./fixtures/pool-txs.json');
  const wrapOnly = {};
  entriesFromLogs(fx['0xa9085cb5a77f248bf7d4dbed352a05b0f4a401febebf3cedb829dbfc06cb7bfe'].logs, new Map(), undefined, undefined, wrapOnly);
  assert.equal(wrapOnly.bodies, undefined);
});

test('a bridge mint is read from settle calldata only when its settle call ran (mint 0x2dbd…)', () => {
  // The burn nullifier a mint spends is in its settle calldata (publicValues field 8) and, independently, in the
  // NullifiersSpent log the pool emitted for the same transaction.
  const { entriesFromLogs } = require('../server/pool-index.cjs');
  const { decodePoolLogs } = require('../server/pool-logs.cjs');
  const fx = require('./fixtures/mint-0x2dbd.json');
  const spentInLog = decodePoolLogs({ logs: fx.logs }).find((e) => e.type === 'nullifiers').nullifiers[0].slice(2);
  const acc = {};
  entriesFromLogs(fx.logs, new Map([[fx.tx, fx.input]]), undefined, undefined, acc);
  assert.deepEqual(acc.mints.map((m) => m.nullifier), [spentInLog]);
  // The same calldata beside unrelated note logs: that call did not run here, so it minted nothing.
  const other = fx.logs.map((l) => ({ ...l, data: l.data.split(spentInLog).join('22'.repeat(32)) }));
  const leaf = decodePoolLogs({ logs: fx.logs }).find((e) => e.type === 'leaves').leaves[0].slice(2);
  const unrelated = other.map((l) => ({ ...l, data: l.data.split(leaf).join('33'.repeat(32)) }));
  const none = {};
  entriesFromLogs(unrelated, new Map([[fx.tx, fx.input]]), undefined, undefined, none);
  assert.equal(none.mints, undefined);
});

test('a Bitcoin bridge burn and its Ethereum mint name the same nullifier, also for a 4-item witness (burn 2b086c…, mint 0x33b4…)', () => {
  // The burn's envelope sits in witness item 1, before its leaf ([signature, envelope, leaf, control]), which is where
  // Tacit's reflection guest reads it. The mint's settle calldata, on the other chain, must consume the same ν.
  const burn = decodeTx(require('./fixtures/bridge-burn-4item-2b086c.json'));
  assert.equal(burn.name, 'bridge burn');
  // It names this pool: ConfidentialPool's CHAIN_BINDING is keccak256(abi.encodePacked(chainid 1, pool address)).
  const { keccak256 } = require('../server/keccak.cjs');
  assert.equal(burn.binding, keccak256(Buffer.from(`${'00'.repeat(31)}01000000000ed1eabd231be41d93b719056f7febfc`, 'hex')).toString('hex'));
  const { entriesFromLogs } = require('../server/pool-index.cjs');
  const mint = require('./fixtures/mint-0x33b4.json');
  const acc = {};
  entriesFromLogs(mint.logs, new Map([[mint.tx, mint.input]]), undefined, undefined, acc);
  assert.deepEqual(acc.mints.map((m) => m.nullifier), [burn.nullifier]);
});

test('pool totals can be taken at any recent block: folded blocks, recent blocks and the unfolded tail', () => {
  const { countsAt } = require('../server/measured-privacy.cjs');
  // Folded through block 100 (spends 50), blocks 95 and 100 are recent, the tail holds block 105. Hand-computed.
  const state = { counts: { nullifiers: 50 }, nextBlock: 101, recentFrom: 90, recent: [{ block: 95, c: { nullifiers: 2 } }, { block: 100, c: { nullifiers: 1 } }], tail: { from: 101, through: 112, byBlock: new Map([[105, { nullifiers: 4 }]]) } };
  const at = (b) => countsAt(state, b)?.nullifiers ?? null;
  assert.deepEqual([112, 105, 104, 100, 99, 95, 94, 90].map(at), [54, 54, 50, 50, 49, 49, 47, 47]);
  assert.equal(at(113), null, 'newer than anything read');
  assert.equal(at(89), null, 'older than this instance can rebuild');
  assert.equal(countsAt({ ...state, tail: { ...state.tail, from: 99 } }, 112), null, 'a tail from before the last fold is ignored');
});

test('visitor privacy promises hold in the headers: this site only, no referrer, no ad-interest APIs', () => {
  const { SECURITY_HEADERS: h } = require('../server/security-headers.cjs');
  const csp = Object.fromEntries(h['content-security-policy'].split('; ').map((d) => { const [k, ...v] = d.split(' '); return [k, v]; }));
  assert.deepEqual(csp['default-src'], ["'self'"]);
  // Besides this site, only a node on the visitor's own computer, for the block check.
  assert.deepEqual(csp['connect-src'], ["'self'", 'http://localhost:*', 'http://127.0.0.1:*']);
  for (const d of ['script-src', 'style-src', 'font-src', 'img-src']) assert.ok(csp[d].every((v) => /^'(self|sha256-[^']+)'$|^data:$/.test(v)), `${d}: ${csp[d]}`);
  assert.equal(h['referrer-policy'], 'no-referrer');
  assert.match(h['permissions-policy'], /browsing-topics=\(\)/);
  assert.match(h['permissions-policy'], /interest-cohort=\(\)/);
});

test('the own-node setting only accepts a node on this computer', async () => {
  const { LOCAL_NODE } = await import('../src/own-node.js');
  for (const ok of ['http://127.0.0.1:8545', 'http://localhost:8545', 'http://localhost:8545/rpc', 'http://127.0.0.1']) assert.ok(LOCAL_NODE.test(ok), ok);
  for (const bad of ['https://eth.example.com', 'http://localhost.evil.com', 'http://127.0.0.1.evil.com:8545', 'http://192.168.1.2:8545', 'http://user@evil.com', 'javascript:alert(1)', 'http://localhost:8545 x']) assert.ok(!LOCAL_NODE.test(bad), bad);
});

test('withdrawal check: linked by recipient or by a self-sent withdrawal, verdicts by share, counted by address', () => {
  const { buildIndex, addressReport, crowd } = require('../server/evm-history.cjs');
  const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40), F = '0x' + 'f'.repeat(40);
  const snap = { chains: { 8453: { through: 100, deposits: [
    { block: 10, addr: A, amount: '100' }, { block: 20, addr: C, amount: '100' }, { block: 30, addr: B, amount: '100' },
  ], withdrawals: [
    { block: 5, addr: B, amount: '100', relayed: true, by: null }, // paid before B ever deposited: no link
    { block: 40, addr: A, amount: '100', relayed: false, by: A }, // A round-trips: linked by recipient
    { block: 45, addr: F, amount: '100', relayed: false, by: C }, // C sends to a fresh F from its own wallet: linked by sender
    { block: 50, addr: F, amount: '100', relayed: true, by: null }, // relayed to F: no link
  ] } } };
  const clock = { head: 200, headTime: 2_000, secs: 1 };
  const idx = buildIndex([{ chain: 8453, clock, events: [{ block: 150, tx: '0x' + '1'.repeat(64), amount: -100n, addr: A, relayed: true, by: null }] }], snap);
  assert.equal(idx.summary.withdrew, 3); // A, B, F
  assert.equal(idx.summary.linked, 2); // A and F
  assert.equal(idx.summary.bySender, 1);
  assert.equal(idx.missingSenders, 0);
  assert.equal(addressReport(idx, A).verdict, 'full');
  assert.equal(addressReport(idx, F).verdict, 'partial');
  assert.equal(addressReport(idx, F).pairs[0].wallet, C);
  assert.equal(addressReport(idx, C).verdict, 'full'); // its one self-sent withdrawal gives its deposit away
  assert.equal(addressReport(idx, B).verdict, 'nolink');
  assert.equal(addressReport(idx, '0x' + 'd'.repeat(40)).verdict, 'none');
  assert.equal(crowd(idx, 8453, '100', 25), 2);
  // The EVM pool card's totals come from the same history: 3 deposits, 4 snapshot withdrawals plus the live one.
  assert.deepEqual({ ...idx.totals[8453], lastTime: undefined }, { deposits: 3, withdrawals: 5, depositWei: 300n, withdrawalWei: 500n, lastBlock: 150, lastTime: undefined });
});

test('withdrawal check: live events already in the snapshot are not counted twice; unread senders hold the verdict', () => {
  const { buildIndex, addressReport } = require('../server/evm-history.cjs');
  const A = '0x' + 'a'.repeat(40), F = '0x' + 'f'.repeat(40);
  const snap = { chains: { 8453: { through: 100, deposits: [{ block: 90, addr: A, amount: '1' }], withdrawals: [] } } };
  const idx = buildIndex([{ chain: 8453, clock: { head: 200, headTime: 200, secs: 1 }, events: [
    { block: 90, tx: '0x1', amount: 1n, addr: A },
    { block: 150, tx: '0x2', amount: -1n, addr: F, relayed: false, by: null }, // self-sent, sender not read yet
  ] }], snap);
  assert.equal(idx.byAddr.get(A).deps.length, 1);
  assert.equal(idx.missingSenders, 1);
  assert.equal(addressReport(idx, F).verdict, 'pending');
});

test('withdrawal check: a chain without live blocks keeps its links (dated by anchors) and holds "no link" as Still reading', () => {
  const { buildIndex, addressReport } = require('../server/evm-history.cjs');
  const A = '0x' + 'a'.repeat(40), F = '0x' + 'f'.repeat(40);
  const snap = { chains: { 8453: { through: 100, anchors: [[0, 1_000], [100, 2_000]], deposits: [{ block: 10, addr: A, amount: '1' }], withdrawals: [
    { block: 50, addr: A, amount: '1', relayed: true, by: null }, { block: 60, addr: F, amount: '1', relayed: true, by: null },
  ] } } };
  const idx = buildIndex([{ chain: 8453, clock: null, events: null }], snap); // the scan has not finished: no clock, no events
  assert.equal(idx.cold, true);
  assert.equal(addressReport(idx, A).verdict, 'full'); // still linked: anchors date the rows without a clock
  assert.equal(addressReport(idx, A).pairs[0].wd.time - addressReport(idx, A).pairs[0].dep.time, 400); // (50-10) × 10 s
  assert.equal(addressReport(idx, F).verdict, 'pending'); // not "No link found" until the live blocks are in
});
