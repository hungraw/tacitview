// Measured privacy (/views/measured-privacy): what is actually linkable on chain, beside the protocol's boundary.
// Left: ConfidentialPool spends that anyone can trace to the transaction that created their note. Right: the EVM
// pool's last 24 hours per chain, and how much of it went straight back to the addresses that deposited.
import { number, escapeHtml, shortId, formatUnits } from '../format.js';

let last = null, chosen = null, range = '24h';
const RANGE_NAMES = { '1h': '1 h', '6h': '6 h', '24h': '24 h' };
const RANGE_WORDS = { '1h': 'hour', '6h': '6 hours', '24h': '24 hours' };
const pct = (a, b) => (b ? (a / b) * 100 : 0);
const share = (a, b) => { const p = pct(a, b); return `${p > 0 && p < 0.1 ? '<0.1' : p < 10 || p > 90 ? p.toFixed(1) : Math.round(p)}%`; };
const ethLink = (tx) => `<a href="#/eth/${escapeHtml(tx)}"><code>${escapeHtml(shortId(tx, 4))}</code></a>`;

function poolSide(p) {
  const max = Math.max(1, ...p.days.map((d) => d[0]));
  // Buckets are 7,200 Ethereum blocks (about a day) counted back from the index head, so they get relative labels.
  const names = p.days.map((_, i) => (i === 6 ? 'Last 24 h' : `${6 - i + 1} d`));
  const days = p.days.map(([s, t], i) => `<div class="mp-day" title="${names[i]}: ${number(s)} spends, ${number(t)} traced in the pool"><i class="is-traced" style="height:${pct(t, max)}%"></i><i style="height:${pct(s - t, max)}%"></i></div>`).join('');
  const latest = p.latest
    ? `<p class="mp-foot">Latest: ${p.latest.lock ? 'lock' : 'note'} ${p.latest.made ? `${ethLink(p.latest.made)} ` : ''}spent in ${ethLink(p.latest.spent)}${p.latest.made ? `, ${number(p.latest.blocks)} blocks later` : ''}</p>` : '';
  const known = p.bitcoin != null; // the Bitcoin-side count comes from Tacit's API and can be unavailable
  const linked = p.traced + (p.bitcoin || 0);
  return `<div class="mp-col">
    <div class="mp-head"><h3 class="mp-title">ConfidentialPool</h3><a class="mp-more" href="#/traced">View traced spends</a></div>
    <p class="mp-big"><b class="num">${number(linked)}</b>of ${number(p.spends)} spends linked</p>
    <p class="mp-sub">A linked spend can be tied to the transaction or Bitcoin burn that created its note.</p>
    <div class="mp-bar" role="img" aria-label="${share(linked, p.spends)} of spends linked"><i class="is-traced" style="width:${Math.max(0.6, pct(p.traced, p.spends))}%"></i>${known ? `<i class="is-btc" style="width:${pct(p.bitcoin, p.spends)}%"></i>` : ''}<i></i></div>
    <div class="mp-key"><span><i class="is-traced"></i>Traced in the pool ${share(p.traced, p.spends)}</span>${known ? `<span><i class="is-btc"></i>Linked through Bitcoin ${share(p.bitcoin, p.spends)}</span><span><i></i>No public link ${share(p.unlinked, p.spends)}</span>` : '<span><i></i>Rest not yet counted</span>'}</div>
    <div class="kv"><span>Locks spent (claim or refund)</span><span class="num">${number(p.lockTraced)} / ${number(p.lockClaims)}</span></div>
    <div class="kv"><span>Bearer notes spent</span><span class="num">${number(p.bearer)}</span></div>
    <div class="kv"><span>Bitcoin burns minted</span><span class="num">${known ? number(p.bitcoinMints) : '—'}</span></div>
    ${p.fastLane ? `<div class="kv"><span>Bitcoin notes spent in the pool</span><span class="num">${number(p.fastLane)}</span></div>` : ''}
    <div class="kv"><span>No public link</span><span class="num">${known ? number(p.unlinked) : '—'}</span></div>
    ${known ? '' : '<p class="mp-sub">The bridge mint count is unavailable right now, so spends linked through Bitcoin are not counted yet.</p>'}
    ${p.synced ? '' : `<p class="mp-sub">Counted through Ethereum block ${number(p.throughBlock)}; newer entries are still being read.</p>`}
    <p class="mp-label">Traced in the pool, last 7 days</p>
    <div class="mp-days">${days}</div><div class="mp-day-names">${names.map((n) => `<span>${n}</span>`).join('')}</div>
    ${latest}
  </div>`;
}

const TONES = ['var(--eth)', 'var(--eth-line)', 'var(--eth-tint)'];
function evmSide(chains) {
  const size = (x) => (x.ranges ? x.ranges['24h'].deposits + x.ranges['24h'].withdrawals : -1);
  const busiest = [...chains].sort((a, b) => size(b) - size(a))[0];
  const pick = chains.find((x) => x.chain === chosen) || busiest || chains[0];
  const tabs = chains.map((x) => `<button type="button" role="tab" aria-selected="${x === pick}" data-mp-chain="${x.chain}">${escapeHtml(x.name)}</button>`).join('');
  const ranges = Object.entries(RANGE_NAMES).map(([k, label]) => `<button type="button" aria-pressed="${k === range}" data-mp-range="${k}">${label}</button>`).join('');
  const c = pick.ranges?.[range];
  let body;
  if (pick.pending) body = `<p class="empty">Reading the last 24 hours of ${escapeHtml(pick.name)}…</p>`;
  else if (!c) body = `<p class="empty">The ${escapeHtml(pick.name)} RPC did not answer. It retries on the next refresh.</p>`;
  else if (!c.deposits && !c.withdrawals && !c.transfers) body = `<p class="empty">No EVM pool activity on ${escapeHtml(pick.name)} in the last ${RANGE_WORDS[range]}.</p>`;
  else {
    const topSum = c.top.reduce((a, t) => a + t.n, 0), others = c.withdrawals - topSum;
    const segs = [...c.top.map((t, i) => [t.n, TONES[i]]), ...(others > 0 ? [[others, 'var(--line-2)']] : [])];
    const legend = [...c.top.map((t, i) => `<div class="mp-recip"><i style="background:${TONES[i]}"></i><span class="mp-addr"><code data-addr="${escapeHtml(t.address)}">${escapeHtml(shortId(t.address, 4))}</code></span><span class="num">${number(t.n)} · ${share(t.n, c.withdrawals)}</span></div>`),
      ...(others > 0 ? [`<div class="mp-recip"><i style="background:var(--line-2)"></i><span class="muted">${number(c.recipients - c.top.length)} other address${c.recipients - c.top.length === 1 ? '' : 'es'}</span><span class="num">${number(others)} · ${share(others, c.withdrawals)}</span></div>`] : [])].join('');
    body = `<div class="mp-stats">
        <div><b class="num">${number(c.deposits)}</b><span>Deposits · ${formatUnits(c.ethIn, 18, 2)} ETH</span></div>
        <div><b class="num">${number(c.withdrawals)}</b><span>Withdrawals · ${formatUnits(c.ethOut, 18, 2)} ETH</span></div>
        <div><b class="num${c.transfers ? '' : ' warn'}">${number(c.transfers)}</b><span>Private transfers</span></div></div>
      <div class="kv"><span>Withdrawn to a depositor</span><span class="num">${number(c.toDepositor)} / ${number(c.withdrawals)}</span></div>
      ${c.sendersRead < c.deposits ? `<p class="mp-sub">Depositors read for ${number(c.sendersRead)} of ${number(c.deposits)} deposits so far.</p>` : ''}
      <div class="kv"><span>Recipient addresses</span><span class="num">${number(c.recipients)}</span></div>
      ${c.withdrawals ? `<p class="mp-label">Where withdrawals went</p><div class="mp-bar">${segs.map(([n, color]) => `<i style="width:${pct(n, c.withdrawals)}%;background:${color}"></i>`).join('')}</div><div class="mp-recips">${legend}</div>` : ''}`;
  }
  if (pick.old && body && !pick.pending) body = `<p class="mp-sub">The ${escapeHtml(pick.name)} RPC is not answering; showing its last good scan.</p>${body}`;
  return `<div class="mp-col"><div class="mp-head"><h3 class="mp-title">EVM pool</h3><div class="mp-seg" role="group" aria-label="Time range">${ranges}</div></div>
    <div class="mp-tabs" role="tablist" aria-label="Chain">${tabs}</div>${body}</div>`;
}

const html = (d) => `<div class="mp" id="mp-root">${poolSide(d.pool)}${evmSide(d.evm || [])}</div>`;

export default {
  id: 'measured-privacy',
  sources: ['measuredPrivacy'],
  render({ measuredPrivacy: d }) {
    last = d;
    return {
      html: html(d),
      about: ['How this is measured', "Traced in the pool: bearer notes and locks are spent with a nullifier made from the leaf alone (bearer notes: Tacit's spec, section 4.1; locks: measured here), so this site checks every nullifier against every leaf since launch. Linked to a Bitcoin burn: each bridge mint spends the nullifier its Bitcoin burn published. No public link: owned notes, spent with a secret key. EVM pool: every Transact event in the range, with each deposit's sender read from its transaction."],
      asOf: '',
      source: '/confidential/index · EVM pool Transact logs · deposit transactions',
    };
  },
};

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-mp-chain], [data-mp-range]');
    if (!tab || !last) return;
    if (tab.dataset.mpChain) chosen = Number(tab.dataset.mpChain);
    if (tab.dataset.mpRange) range = tab.dataset.mpRange;
    const root = document.getElementById('mp-root');
    if (root) {
      root.innerHTML = poolSide(last.pool) + evmSide(last.evm || []);
      import('../names.js').then((m) => m.annotateAddresses(root)); // name tags again after the redraw (browser only)
    }
  });
}
