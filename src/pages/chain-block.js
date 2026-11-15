// Tacit chain block page (/views/chain-block): a hash-linked block anchored to an Ethereum transaction.
import { escapeHtml, number, shortId, link, ethAt, siteLink, POOL_EVENT } from '../format.js';
import { pageHead, kvTable, pagerNav } from './common.js';
import { verifyPanel } from '../verify-ui.js';

export function renderChainBlock(d) {
  const events = (d.poolEvents || []).map((e) => `<div class="row"><span class="row-key"><code>log ${number(e.logIndex)}</code></span><span class="row-main"><strong class="eth">${e.type === 'leaves' ? 'Note created' : e.type === 'nullifiers' ? 'Note spent' : escapeHtml(POOL_EVENT[e.type] || e.type)}</strong><span>${e.type === 'leaves' ? `leaf #${number(e.leafIndex)} · <code>${escapeHtml(shortId(e.leaves?.[0], 8))}</code>` : e.type === 'nullifiers' ? `nullifier <code>${escapeHtml(shortId(e.nullifiers?.[0], 8))}</code>` : ''}</span></span><span class="row-end"></span></div>`).join('');
  return [
    pageHead({ crumbs: [['Tacit chain', '#/'], ['Block']], title: `Tacit chain block ${number(d.height)}`, id: d.hash, chips: [[`${number(d.notes)} note${d.notes === 1 ? '' : 's'} · ${number(d.spent)} spent`, 'eth'], ...(d.verification ? [[d.verification.status === 'verified' ? 'Hash content verified' : d.verification.status === 'mismatch' ? 'Hash differs from its content' : 'Hash not checked', d.verification.status === 'verified' ? 'ok' : d.verification.status === 'mismatch' ? 'bad' : '']] : [])] }),
    `<div class="grid grid-3-2">`,
    kvTable([
      ['Height', `${number(d.height)}${d.head ? ` of ${number(d.head)}` : ''}`, { mono: true }],
      ['Parent', d.height > 1 ? `<a href="#/chain/${d.height - 1}"><code>${escapeHtml(shortId(d.prev, 10))}</code></a>` : '—'],
      ['Anchored in', `<a href="#/eth/${escapeHtml(d.tx)}"><code>${escapeHtml(shortId(d.tx, 10))}</code></a>${siteLink(`https://etherscan.io/tx/${d.tx}`, 'Etherscan')} · ${ethAt(d.ethBlock)}`],
      ['Notes', number(d.notes), { mono: true }],
      ['Spent', number(d.spent), { mono: true }],
      ['Deposits', number(d.deposits), { mono: true }],
      d.verification && ['Same as Tacit', d.verification.status === 'verified' ? `<span class="ok">Match</span> · ${escapeHtml(d.verification.reason || '')}. This site rebuilds every block from Ethereum itself.` : d.verification.status === 'mismatch' ? `<span class="bad">Differs</span> · ${escapeHtml(d.verification.reason || '')}` : `<span class="muted">${escapeHtml(d.verification.reason || 'Not compared yet')}</span>`],
      d.height > 1 && ['Parent link', d.parentLinked === true ? `<span class="ok">Matches</span> block ${number(d.height - 1)}'s hash` : d.parentLinked === false ? `<span class="bad">Differs</span> from block ${number(d.height - 1)}'s hash` : '<span class="muted">not checked</span>'],
    ]),
    `<section class="card"><header class="card-head"><h2>Pool events</h2></header>
      <div class="rows">${d.poolEvents == null ? '<p class="empty">Pool events could not be loaded right now (upstream rate limit).</p>' : events || '<p class="empty">None in the anchoring transaction.</p>'}</div>
      ${pagerNav(d.height > 1 ? `#/chain/${d.height - 1}` : null, d.head && d.height < d.head ? `#/chain/${d.height + 1}` : null)}</section>`,
    `</div>`,
    verifyPanel(d),
  ].join('');
}
