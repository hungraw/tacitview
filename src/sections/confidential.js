// Ethereum ConfidentialPool: latest note events as tiles, plus totals.
import { number, escapeHtml, term, ethAt, metrics } from '../format.js';

const KIND = { leaves: 'created', nullifiers: 'spent', wrap: 'wrap', crossOut: 'cross-out', lockLeaves: 'lock', bitcoinConsumed: 'consumed', cdpPosition: 'cdp', assetRegistered: 'asset' };

export default {
  id: 'confidential',
  sources: ['confidential'],
  render({ confidential: d }) {
    // Five rows beside Farms on the Ethereum page; six beside the Bitcoin grid on the home page.
    const count = typeof location !== 'undefined' && location.hash.startsWith('#/ethereum') ? 25 : 30;
    const tiles = (d.entries || []).slice(0, count).map((e) => {
      const kind = KIND[e.type] || e.type;
      return `<a class="tile tile-eth is-${escapeHtml(e.type)}" data-key="${escapeHtml(`${e.tx}:${e.logIndex}`)}" href="#/eth/${escapeHtml(e.tx)}" title="${escapeHtml(`${kind} · Ethereum block ${number(e.block)} · log ${e.logIndex}`)}" aria-label="${escapeHtml(`${kind}, Ethereum block ${number(e.block)}`)}"><span class="tile-kind">${escapeHtml(kind.charAt(0).toUpperCase() + kind.slice(1))}</span><span class="tile-num">${(e.leavesCount ?? e.nullifiersCount) > 1 ? `×${number(e.leavesCount ?? e.nullifiersCount)}` : ''}</span></a>`;
    }).join('');
    const c = d.counts || {};
    return {
      html: `<div class="tiles tiles-5">${tiles}</div><ul class="legend">
        <li><i class="key tile-eth is-leaves"></i>${term('Note created')} <b>${number(c.leaves)}</b></li>
        <li><i class="key tile-eth is-nullifiers"></i>${term('Note spent')} <b>${number(c.nullifiers)}</b></li>
        <li><i class="key tile-eth is-other"></i>${term('Wraps')} <b>${number(c.wraps)}</b></li><li>${term('Cross-outs')} <b>${number(c.crossOuts)}</b></li></ul>`,
      status: metrics([['Ethereum block', number(d.asOf.headBlock), 'eth']]),
      // Created is the contract's leaf count; the other totals are this site's own count of the pool's logs, which
      // trails the head by a few blocks while it reads.
      asOf: d.asOf.totalsThrough && !d.asOf.totalsSynced ? `Totals through Ethereum block ${number(d.asOf.totalsThrough)}; newer blocks are being read` : '',
      source: 'pool logs · nextLeafIndex()',
    };
  },
};
