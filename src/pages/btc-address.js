// Bitcoin address page (/views/btc-address): balance chart, Tacit activity, assets touched, transactions.
// The chart and counts cover the transactions loaded so far (newest 50, then 25 more per "Load older").
import { escapeHtml, number, shortId, relativeTime, siteLink, btcAmount, assetName, assetIcon, chainBadge, info } from '../format.js';
import { pageHead, copyIcon } from './common.js';
import { filterBar, initFilters } from '../filters.js';
import { detail } from '../data/api.js';

const signed = (sats) => (sats > 0 ? `+${btcAmount(sats)}` : sats < 0 ? `−${btcAmount(-sats)}` : btcAmount(0));
const day = (t) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
const ICON = {
  in: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11 5 5 11M5 6v5h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  out: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 11 11 5M6 5h5v5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  tacit: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5 13.5 8 8 13.5 2.5 8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
};

// Balance after each transaction, oldest first: walk back from today's balance through the loaded transactions.
function balanceSeries(d) {
  let b = d.balance;
  const pts = d.txs.map((t) => { const p = { ...t, balance: b }; b -= t.delta; return p; });
  return pts.reverse();
}

function chart(pts) {
  if (pts.length < 2) return '<p class="empty">Not enough history to draw.</p>';
  const W = 640, H = 150, P = 6;
  const max = Math.max(...pts.map((p) => p.balance), 1);
  const x = (i) => P + (i * (W - 2 * P)) / (pts.length - 1);
  const y = (v) => H - P - (Math.max(0, v) / max) * (H - 2 * P);
  let line = `M${x(0).toFixed(1)},${y(pts[0].balance).toFixed(1)}`;
  pts.forEach((p, i) => { if (i) line += `H${x(i).toFixed(1)}V${y(p.balance).toFixed(1)}`; });
  const dots = pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.balance).toFixed(1)}" r="2.8" class="${p.op ? 'is-tacit' : ''}"><title>${escapeHtml(`${day(p.time) || 'pending'} · ${p.op || 'Bitcoin'} · ${signed(p.delta)} · balance ${btcAmount(p.balance)}`)}</title></circle>`).join('');
  return `<svg class="bal-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Balance after each of the last ${pts.length} transactions"><path class="area" d="${line}V${H - P}H${x(0).toFixed(1)}Z"/><path class="line" d="${line}"/>${dots}</svg>`
    + `<div class="bal-axis"><span>${escapeHtml(day(pts[0].time))}</span><span class="bal-key"><i class="is-tacit"></i>Tacit <i></i>Bitcoin</span><span>${escapeHtml(day(pts.at(-1).time) || 'now')}</span></div>`;
}

function tacitCard(d) {
  const tacit = d.txs.filter((t) => t.op);
  const ops = [...tacit.reduce((m, t) => m.set(t.op, (m.get(t.op) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
  const top = ops[0]?.[1] || 1;
  const assets = [...new Map(tacit.filter((t) => t.asset).map((t) => [t.asset.id, t.asset])).values()];
  const inOut = d.chain.received + d.chain.sent || 1;
  return `<section class="card"><header class="card-head"><h2>Tacit activity</h2><span class="status">${number(tacit.length)} of ${number(d.txs.length)}</span></header>`
    + (ops.length ? ops.map(([op, n]) => `<div class="op-bar"><code>${escapeHtml(op)}</code><i style="--w:${Math.max(4, Math.round((n / top) * 100))}%"></i><span class="num">${number(n)}</span></div>`).join('') : '<p class="empty">None in these transactions.</p>')
    + (assets.length ? `<p class="mini-label">Assets touched</p><div class="asset-chips">${assets.map((a) => `<a class="asset-name chip-link" href="#/asset/${escapeHtml(a.id)}">${assetIcon(a.id, a.ticker)}${escapeHtml(assetName(a.ticker, a.id))}</a>`).join('')}</div>` : '')
    + `<p class="mini-label">Received · sent, all time</p><div class="split"><i style="--w:${Math.round((d.chain.received / inOut) * 100)}%"></i></div>`
    + `<p class="note">${btcAmount(d.chain.received)} in · ${btcAmount(d.chain.sent)} out</p></section>`;
}

const txRow = (t) => {
  const kind = t.op ? 'tacit' : t.delta > 0 ? 'in' : 'out';
  return `<div class="tx-row" data-f="${kind}${t.height ? '' : ' pending'}" data-q="${escapeHtml(`${t.txid} ${t.op || ''} ${t.asset?.ticker || ''} ${t.height || ''}`.toLowerCase())}"><span class="tx-icon is-${kind}" title="${kind === 'tacit' ? 'Tacit transaction' : kind === 'in' ? 'Received' : 'Sent'}">${ICON[kind]}</span>`
    + `<span class="tx-main"><span class="hash-cell"><a href="#/tx/${escapeHtml(t.txid)}"><code>${escapeHtml(shortId(t.txid, 6))}</code></a>${copyIcon(t.txid, 'transaction id')}</span>`
    + (t.op ? ` <span class="chip btc">${escapeHtml(t.op)}</span>${t.asset ? ` <a class="muted" href="#/asset/${escapeHtml(t.asset.id)}">${escapeHtml(assetName(t.asset.ticker, t.asset.id))}</a>` : ''}` : ' <span class="muted">Bitcoin</span>')
    + `</span><span class="tx-when">${t.height ? `<a href="#/block/${t.height}">${number(t.height)}</a> · ${relativeTime(t.time)}` : '<span class="chip warn">Pending</span>'}</span>`
    + `<span class="tx-delta num ${t.delta > 0 ? 'ok' : ''}">${signed(t.delta)}</span></div>`;
};

export function renderBtcAddress(d) {
  const tacit = d.txs.filter((t) => t.op).length;
  const kinds = d.txs.reduce((m, t) => { const k = t.op ? 'tacit' : t.delta > 0 ? 'in' : 'out'; m[k] = (m[k] || 0) + 1; if (!t.height) m.pending = (m.pending || 0) + 1; return m; }, {});
  const bar = filterBar('btc-address-txs', { total: d.txs.length, scope: 'loaded', remember: false, search: d.txs.length > 8 ? 'Filter by transaction, op, asset or block' : '',
    groups: [{ name: 'kind', label: 'Kind', options: [['tacit', 'Tacit', kinds.tacit], ['in', 'Received', kinds.in], ['out', 'Sent', kinds.out], ['pending', 'Unconfirmed', kinds.pending]] }] });
  const span = d.txs.length > 1 && d.txs.at(-1).time ? Math.max(1, Math.round(((d.txs[0].time || Date.now() / 1000) - d.txs.at(-1).time) / 86400)) : null;
  return [
    pageHead({
      crumbs: [['Bitcoin', '#/bitcoin'], ['Address']], title: 'Bitcoin address', id: d.address, icon: chainBadge('btc', 'lg'),
      chips: [[`${number(d.chain.txs + d.mempool.txs)} transactions`, 'btc'], ...(tacit ? [[`${tacit} with Tacit envelopes`, '']] : []), ...(d.mempool.txs ? [[`${d.mempool.txs} unconfirmed`, 'warn']] : [])],
      links: [siteLink(`https://mempool.space/address/${d.address}`, 'mempool.space'), siteLink(`https://tacitscan.io/address/${d.address}`, 'tacitscan.io')],
    }),
    `<div class="grid addr-grid"><section class="card"><header class="card-head"><div><p class="mini-label">Balance</p><p class="bal-big num">${btcAmount(d.balance)}</p></div><span class="status">Last ${number(d.txs.length)} transactions${span ? ` · ${span} day${span === 1 ? '' : 's'}` : ''}</span></header>${chart(balanceSeries(d))}</section>${tacitCard(d)}</div>`,
    `<section class="card" id="addr-txs"><header class="card-head"><h2>Transactions</h2><span class="card-head-end"><span class="status">newest ${number(d.txs.length)}</span>${info(['What is public here', 'Bitcoin addresses and BTC amounts are public. Tacit hides what moves inside a transaction: the asset amounts in its notes.'], { end: true })}</span></header>${bar}`
      + (d.txs.length ? d.txs.map(txRow).join('') : '<p class="empty">None yet.</p>')
      + (d.more && d.last ? `<nav class="pager"><span></span><button type="button" class="load-older" data-address="${escapeHtml(d.address)}" data-after="${escapeHtml(d.last)}">Load older</button></nav>` : '')
      + '</section>',
  ].join('');
}

// "Load older": fetch the next 25 confirmed transactions and redraw the page with them added (chart and counts too).
const loaded = new Map(); // address -> page data so far
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('click', async (event) => {
  const button = event.target.closest('button.load-older');
  if (!button) return;
  const { address, after } = button.dataset;
  button.disabled = true;
  button.textContent = 'Loading…';
  try {
    const base = loaded.get(address) || await detail('btc-address', address);
    const older = await detail('btc-address-txs', `${address}:${after}`);
    const seen = new Set(base.txs.map((t) => t.txid));
    const next = { ...base, txs: [...base.txs, ...older.txs.filter((t) => !seen.has(t.txid))], last: older.last, more: older.more };
    loaded.set(address, next);
    const page = document.getElementById('page');
    if (location.hash.endsWith(address)) { const y = window.scrollY; page.innerHTML = renderBtcAddress(next); initFilters(page); window.scrollTo(0, y); }
  } catch {
    button.disabled = false;
    button.textContent = 'Could not load. Try again';
  }
});
