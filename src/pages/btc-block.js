// Bitcoin block page (/views/btc-block): every Tacit envelope in the block, decoded from raw bytes.
import { escapeHtml, number, shortId, link, relativeTime, siteLink, timePill, assetName, chainBadge } from '../format.js';
import { pageHead, kvTable, bridgeStrip, pagerNav, copyIcon } from './common.js';
import { filterBar } from '../filters.js';

export function renderBtcBlock(d) {
  const opOf = (e) => e.name || e.opcodeHex;
  const rows = d.envelopes.map((e) => `<div class="row" data-f="${escapeHtml(opOf(e))}" data-q="${escapeHtml(`${e.txid} ${opOf(e)} ${e.ticker || ''}`.toLowerCase())}"><span class="row-key"><code>#${number(e.index)}</code></span><span class="row-main"><strong><code>${escapeHtml(e.name || e.opcodeHex)}</code>${e.ticker ? ` <span class="btc">${escapeHtml(e.assetId ? assetName(e.ticker, e.assetId) : e.ticker)}</span>` : ''}</strong><span>${e.vin ? `input ${number(e.vin)} · ` : ''}${e.outputs != null ? `${number(e.outputs)} note${e.outputs === 1 ? '' : 's'}` : escapeHtml(e.opcodeHex)}</span></span><span class="row-end"><span class="hash-cell"><a href="#/tx/${escapeHtml(e.txid)}"><code>${escapeHtml(shortId(e.txid, 6))}</code></a>${copyIcon(e.txid, 'transaction id')}</span></span></div>`).join('');
  const ops = d.envelopes.reduce((m, e) => m.set(opOf(e), (m.get(opOf(e)) || 0) + 1), new Map());
  const bar = d.envelopes.length > 4 ? filterBar('btc-block-envelopes', { total: d.envelopes.length, scope: 'in this block', remember: false, search: d.envelopes.length > 10 ? 'Filter by transaction, op or asset' : '', groups: [{ name: 'op', label: 'Op', options: [...ops].sort((a, b) => b[1] - a[1]).map(([op, n]) => [op, op, n]) }] }) : '';
  return [
    pageHead({ crumbs: [['Bitcoin', '#/'], ['Block']], title: `Block ${number(d.height)}`, id: d.hash, icon: chainBadge('btc', 'lg'), chips: [[`${number(d.envelopes.length)} Tacit envelope${d.envelopes.length === 1 ? '' : 's'}`, 'btc']], links: [siteLink(`https://mempool.space/block/${d.hash}`, 'mempool.space')] }),
    bridgeStrip({ confirmations: d.confirmations, bridge: d.bridge, height: d.height }),
    `<div class="grid grid-3-2">`,
    kvTable([
      ['Height', number(d.height), { mono: true }],
      ['Time', timePill(d.time)],
      ['Transactions', number(d.txCount), { mono: true }],
      ['Size', `${number(d.size)} B · ${number(d.weight)} WU`, { mono: true }],
      ['Previous', `<a href="#/block/${d.height - 1}"><code>${escapeHtml(shortId(d.previous, 10))}</code></a>`],
    ]),
    `<section class="card"><header class="card-head"><h2>Envelopes</h2></header>${bar}<div class="rows">${rows || '<p class="empty">None in this block.</p>'}</div>
      ${pagerNav(`#/block/${d.height - 1}`, d.confirmations > 1 ? `#/block/${d.height + 1}` : null)}</section>`,
    `</div>`,
  ].join('');
}
