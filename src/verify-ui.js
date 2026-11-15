// "Check this block yourself" on Tacit chain block pages: the visitor's browser fetches the anchoring transaction's
// raw receipt and calldata (relayed by /views/chain-raw), decodes them and recomputes the block hash itself
// (src/verify-block.js), then compares it with the hash this site computed (and the page compares that with Tacit's).
import { detail } from './data/api.js';
import { verifyBlock } from './verify-block.js';
import { escapeHtml, number, shortId, info } from './format.js';
import { ethNode } from './own-node.js';

// With a node set in settings, the receipt and calldata come straight from it, so this site only supplies the hash
// this site computed (the claim being checked). The node must allow this site's origin (CORS), e.g. geth or reth with
// --http.corsdomain set to it.
async function fromNode(url, raw) {
  const call = async (method, params) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await res.json();
    if (j.error || !j.result) throw new Error(j.error?.message || `${method} returned nothing`);
    return j.result;
  };
  const tx = raw.published.tx;
  const [receipt, t] = await Promise.all([call('eth_getTransactionReceipt', [tx]), call('eth_getTransactionByHash', [tx])]);
  return { ...raw, receipt: { blockNumber: receipt.blockNumber, transactionHash: receipt.transactionHash, logs: receipt.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex })) }, input: t.input };
}

const row = (k, v, cls = '') => `<div class="kvrow${cls ? ` ${cls}` : ''}"><span>${k}</span><span>${v}</span></div>`;
const hash = (h, cls = '') => `<code class="h-full${cls ? ` ${cls}` : ''}">${escapeHtml(h)}</code><code class="h-short${cls ? ` ${cls}` : ''}" title="${escapeHtml(h)}">${escapeHtml(shortId(h, 8))}</code>`;
const list = (values, source) => (values.length ? `<code>${values.map((v) => escapeHtml(shortId(v, 6))).join(', ')}</code> <span class="muted">· ${source}</span>` : '<span class="muted">none</span>');

export function verifyPanel(d) {
  const created = (d.poolEvents || []).filter((e) => e.type === 'leaves');
  const spent = (d.poolEvents || []).filter((e) => e.type === 'nullifiers');
  return `<section class="card verify" id="verify" data-height="${d.height}">
    <header class="card-head"><h2>Check this block yourself</h2><span class="card-head-end">${info(['What this check does', "Your browser rebuilds this block's hash from its inputs and compares it with the hash this site shows."], { end: true })}</span></header>
    <div class="verify-inputs">
      ${row('Parent hash', hash(d.prev || ''))}
      ${row('Height', `<span class="num">${number(d.height)}</span>`)}
      ${row('Ethereum block', `<span class="num">${number(d.ethBlock)}</span>`)}
      ${row('Ethereum tx', `<a href="#/eth/${escapeHtml(d.tx)}">${hash(d.tx)}</a>`)}
      ${row(`Note leaves (${number(d.notes)})`, created.length ? list(created.flatMap((e) => e.leaves || []), `LeavesInserted, log ${created.map((e) => e.logIndex).join(', ')}`) : '<span class="muted">none</span>', 'v-leaves')}
      ${row(`Nullifiers (${number(d.spent)})`, spent.length ? list(spent.flatMap((e) => e.nullifiers || []), `NullifiersSpent, log ${spent.map((e) => e.logIndex).join(', ')}`) : '<span class="muted">none</span>', 'v-nullifiers')}
    </div>
    <p class="verify-formula"><code>keccak256( parent ‖ uint64 height ‖ uint64 ethBlock ‖ tx ‖ keccak256(leaves…) ‖ keccak256(nullifiers…) )</code></p>
    <div class="verify-result" hidden aria-live="polite"></div>
    <div class="verify-actions"><button type="button" class="verify-go">Recompute in my browser</button><span class="muted verify-hint">Decoding and hashing run on this device${ethNode() ? ', with data from your node' : ''}.</span></div>
  </section>`;
}

async function run(panel) {
  const go = panel.querySelector('.verify-go'), out = panel.querySelector('.verify-result'), hint = panel.querySelector('.verify-hint');
  panel.classList.add('is-open'); // refills leave the page alone from now on (main.js)
  go.disabled = true; go.textContent = 'Recomputing…';
  out.hidden = true;
  let raw;
  const node = ethNode();
  try { raw = await detail('chain-raw', panel.dataset.height); } catch (e) {
    out.innerHTML = `<p class="verify-verdict bad">Could not fetch the transaction right now. ${escapeHtml(e.message || '')}</p>`;
    out.hidden = false; go.disabled = false; go.textContent = 'Try again';
    return;
  }
  if (node) {
    try { raw = await fromNode(node, raw); } catch (e) {
      out.innerHTML = `<p class="verify-verdict bad">Could not read the transaction from your node at ${escapeHtml(node)}. Check that it is running and allows this site (CORS). ${escapeHtml(e.message || '')}</p>`;
      out.hidden = false; go.disabled = false; go.textContent = 'Try again';
      return;
    }
  }
  const r = verifyBlock(raw);
  // The leaves and nullifiers rows now show what this browser decoded (lock leaves and lock nullifiers included).
  const leaves = [...r.leaves.note, ...r.leaves.lock], nullifiers = [...r.nullifiers.note, ...r.nullifiers.lock];
  panel.querySelector('.v-leaves').innerHTML = `<span>Note leaves (${leaves.length})</span><span>${list(leaves, `decoded here from ${r.leaves.logs.length === 1 ? 'log' : 'logs'} ${r.leaves.logs.join(', ') || '—'}`)}</span>`;
  panel.querySelector('.v-nullifiers').innerHTML = `<span>Nullifiers (${nullifiers.length})</span><span>${list(nullifiers, `decoded here${r.nullifiers.lock.length ? `, ${r.nullifiers.lock.length} from the settle calldata` : ''}`)}</span>`;
  const ok = r.match && r.receiptMatches;
  const ms = r.ms < 1 ? '<1' : r.ms.toFixed(0);
  out.innerHTML = row('Your browser got', hash(`0x${r.computed}`, ok ? 'ok' : 'bad'))
    + row('This site shows', hash(`0x${r.published}`))
    + (ok
      ? `<p class="verify-verdict ok"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.3 3 3 6-6.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>Match: this block's hash matches its contents, computed on this device in ${ms} ms</p>`
      : `<p class="verify-verdict bad">${r.receiptMatches ? 'No match: the hash rebuilt from Ethereum differs from the one this site shows.' : 'No match: the transaction data does not belong to this block.'}</p>`)
    + `<p class="note">${node ? `The logs and calldata came straight from your node at ${escapeHtml(node)}; this site only supplied the hash it shows.` : 'The logs reach your browser through this site, which reads them from Ethereum. To leave this site out, set your own node in settings.'} The check uses the parent hash shown above; the Parent link row checks it against the block before. <button type="button" class="copy verify-copy">Copy inputs</button></p>`;
  out._raw = raw;
  out.hidden = false;
  go.disabled = false; go.textContent = 'Recompute again';
  hint.textContent = `Last run ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.`;
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('click', async (event) => {
    const go = event.target.closest('.verify-go');
    if (go) { run(go.closest('.verify')); return; }
    const copy = event.target.closest('.verify-copy');
    if (copy) {
      const raw = copy.closest('.verify-result')?._raw;
      if (!raw) return;
      try { await navigator.clipboard.writeText(JSON.stringify(raw, null, 2)); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy failed'; }
      setTimeout(() => { copy.textContent = 'Copy inputs'; }, 1500);
    }
  });
}
