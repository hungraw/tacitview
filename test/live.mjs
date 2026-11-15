// Live integration: every route and view the page uses, through the real proxy handler, against mainnet.
// Then every section renders from that live data. Assertions are invariants that must hold on real data,
// not snapshots of today's numbers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { SECTIONS } from '../src/sections/index.js';
import { renderFootprint } from '../src/sections/footprint.js';

const require = createRequire(import.meta.url);
const { apiHandler } = require('../server/api-handler.cjs');
const { SOURCES } = await import('../src/data/api.js');

function getOnce(path) {
  return new Promise((resolve) => {
    const res = { writeHead(status, headers = {}) { this.status = status; this.headers = headers; }, end(body = '') { resolve({ status: this.status, headers: this.headers, body: JSON.parse(body) }); } };
    apiHandler({ url: `/api${path}`, method: 'GET' }, res);
  });
}
// As the browser does (src/data/api.js fetchWithRetry): one more try 1.5s after a 504, when a cold build passed the
// 8s deadline and carried on into the cache. Also once more after 3s on an RPC that did not answer (503) or an
// upstream rate limit (429, or a 502 carrying one): free endpoints blip, and back-to-back runs hit their limits.
async function get(path) {
  const first = await getOnce(path);
  const blip = first.status === 503 || first.status === 429 || (first.status === 502 && /429|cooling/.test(first.body?.detail || ''));
  if (first.status !== 504 && !blip) return first;
  await new Promise((resolve) => setTimeout(resolve, blip ? 3000 : 1500));
  return getOnce(path);
}

const data = {};
const rateLimited = new Set(); // upstream said 429: not our bug, reported instead of failed
test('every page source loads with shared-cache headers', async (t) => {
  await Promise.all(Object.entries(SOURCES).map(async ([name, [path]]) => {
    const r = await get(path);
    if ((r.status === 502 && /HTTP 429/.test(r.body?.detail || '')) || (r.status === 429 && /rate limit|cooling/.test(r.body?.detail || ''))) { rateLimited.add(name); t.diagnostic(`${name}: upstream rate limit (429), skipped`); return; }
    assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body).slice(0, 200)}`);
    data[name] = { data: r.body };
    // Partial results (an upstream was rate-limited) must not be cached by the CDN; complete ones must be.
    assert.match(r.headers['cache-control'], r.body?.partial ? /no-store/ : /s-maxage=\d+/, name);
    if (r.body?.partial) t.diagnostic(`${name}: partial (an upstream was rate-limited)`);
  }));
  assert.ok(rateLimited.size < Object.keys(SOURCES).length / 2, 'most sources must load');
});

test('every section renders from live data without falling back to its error state', async (t) => {
  const el = (onHtml = () => {}) => ({ dataset: {}, classList: { add() {}, remove() {} }, querySelectorAll: () => [], set innerHTML(v) { onHtml(v); }, set textContent(v) {} });
  globalThis.document = { getElementById: () => el() };
  const { renderSection } = await import('../src/sections/index.js');
  for (const section of SECTIONS) {
    const blocked = section.sources.filter((s) => rateLimited.has(s) && !(section.optional || []).includes(s));
    if (blocked.length) { t.diagnostic(`${section.id}: skipped, ${blocked.join(', ')} rate-limited`); continue; }
    assert.equal(renderSection(section, data).ok, true, section.id);
  }
  // A failed source must show an error, never an empty-looking section.
  let html = '';
  globalThis.document = { getElementById: () => el((v) => { html = v; }) };
  assert.equal(renderSection(SECTIONS.find((s) => s.id === 'assets'), { assetList: { error: new Error('HTTP 502') } }).ok, false);
  assert.match(html, /unavailable right now/);
});

test('live data invariants', (t) => {
  if (['confidential', 'envelopes', 'evmPools', 'privacy', 'checks', 'btcBlocks'].some((n) => rateLimited.has(n))) return t.skip('a needed source was rate-limited');
  const conf = data.confidential.data;
  assert.equal(conf.entries.length, 30);
  const order = (e) => e.block * 1e5 + e.logIndex;
  assert.ok(conf.entries.every((e, i) => i === 0 || order(e) <= order(conf.entries[i - 1])), 'pool events newest first');
  const hash = data.checks.data.rows.find((r) => r.figure === 'Attested block hash');
  assert.ok(hash.error || hash.status === 'match', `attested tip on Ethereum must be the real Bitcoin block: ${hash.api} vs ${hash.chain}`);
  assert.ok(data.envelopes.data.rows.some((r) => r.op?.name), 'envelope opcodes decode on live txs');
  assert.deepEqual(data.evmPools.data.chains.map((c) => c.chain).sort((a, b) => a - b), [1, 4663, 8453]);
  assert.ok(data.privacy.data.rows.every((r) => r.example.id && r.public.length && r.hidden.length));
  assert.equal(data.checks.data.rows.length, 7, 'seven bridge, API and Tacit chain checks');
  // This site's own count of pool spends (rebuilt from Ethereum) against Tacit's index, at the same block.
  const spends = data.checks.data.rows.find((r) => r.figure === 'Pool spends');
  assert.ok(spends.error || ['match', 'stale'].includes(spends.status), `pool spends: ours ${spends.chain}, Tacit ${spends.api} (${spends.status})`);
  assert.ok(data.checks.data.rows.every((r) => r.repro.length === 2), 'every check carries two reproduce commands');
  assert.ok(data.bridgeLag.data.relay.length > 0 && data.bridgeLag.data.btc.length > 0, 'bridge lag has relay and Bitcoin history');
  assert.ok(data.bridgeBurns.data.burns.every((b) => b.step >= 1 && b.step <= 5), 'every burn has a step');
  const blocks = data.btcBlocks.data.blocks;
  assert.ok(blocks.length >= 12 && blocks.every((b, i) => i === 0 || b.height === blocks[i - 1].height - 1), 'contiguous recent Bitcoin blocks');
});

test('footprint resolves each input type', async () => {
  const q = (s) => get(`/views/footprint?q=${encodeURIComponent(s)}`).then((r) => r.body);
  const [xns, ethTx, tacit] = await Promise.all([
    q('vitalik@eth'),
    q('0xd515015749d2546fd0816d777de6b327b837626c049f8df6b91534ca17386e1c'),
    q('tacit1qqpsx7l42csv089rxthxphs9ak60k88uxvjuedxth6mnh8gpvg20fzs9qwag5gsjff24wmn8a87huw8qqa277skk4h6scp30lucp0nfsvqgggqek9lwmtnmwuerfvrp0yvc5h0c33uluyuu6gnd7nx7aqd97zreelgmazmjd'),
  ]);
  assert.ok(JSON.stringify(xns.items).includes('0xd8da6bf26964af9d7eed9e03e53415d37aa96045'), 'XNS resolves vitalik@eth');
  assert.ok(JSON.stringify(ethTx.items).includes('ConfidentialPool'), 'EVM tx shows the Tacit contract it touched');
  assert.equal(tacit.items[0]?.title, 'Unified Tacit address', 'full-length tacit1 address is not truncated');
  assert.match(renderFootprint(xns), /0xd8da6bf2/i, 'the resolved address is on the page');
  assert.match(renderFootprint(ethTx), /ConfidentialPool/);
  assert.match(renderFootprint(tacit), /Unified Tacit address/);
});

test('detail pages render for real ids, and unknown ids are 404', async (t) => {
  const pages = {
    'btc-tx': ['f46f0e329d004df19cb9c3c026f10a3d33a8680196722c0aac47b4a68c569294', (await import('../src/pages/btc-tx.js')).renderBtcTx],
    'eth-tx': ['0xd515015749d2546fd0816d777de6b327b837626c049f8df6b91534ca17386e1c', (await import('../src/pages/eth-tx.js')).renderEthTx],
    'btc-block': ['975146', (await import('../src/pages/btc-block.js')).renderBtcBlock],
    'btc-address': ['bc1q39e7p3jy977l50njxp2mh3cpzr375pgheycxqx', (await import('../src/pages/btc-address.js')).renderBtcAddress],
    // Tacit's API keeps only its newest blocks, so take one from the current list rather than a fixed height.
    'chain-block': [String((await get('/views/chain-list')).body?.blocks?.[5]?.height ?? ''), (await import('../src/pages/chain-block.js')).renderChainBlock],
  };
  for (const [view, [id, render]] of Object.entries(pages)) {
    const r = await get(`/views/${view}?id=${id}`);
    if (r.status === 502 && /429|cooling/.test(r.body?.detail || '')) { t.diagnostic(`${view}: upstream rate limit, skipped`); continue; }
    assert.equal(r.status, 200, `${view}: ${JSON.stringify(r.body).slice(0, 200)}`);
    const html = render(r.body);
    assert.match(html, /<h1>[^<]+/, `${view}: a titled page`);
    assert.ok(html.toLowerCase().replace(/(\d),(?=\d{3})/g, '$1').includes(id.toLowerCase().slice(0, 16)), `${view}: the page shows the id it was asked for`); // heights are shown as 975,146
  }
  const block = (await get('/views/btc-block?id=975146')).body;
  if (block.envelopes) assert.ok(block.envelopes.some((e) => e.name === 'T_BTC_SHIELD'), 'block 975146 holds the T_BTC_SHIELD tacitscan shows');
  assert.equal((await get(`/views/btc-tx?id=${'0'.repeat(63)}1`)).status, 404);
  assert.equal((await get('/views/eth-tx?id=nonsense')).status, 404);
});

test('Tacit chain blocks re-hash from Ethereum logs to the same value Tacit reports', async (t) => {
  const r = await get('/views/chain-list?id=');
  if (r.status === 502) return t.skip(`upstream unavailable: ${r.body?.detail}`);
  const checked = r.body.blocks.filter((b) => b.verification !== 'unverifiable');
  assert.ok(checked.length >= 10, 'most recent blocks are checkable');
  for (const b of checked) assert.equal(b.verification, 'verified', `block ${b.height}`);
});
