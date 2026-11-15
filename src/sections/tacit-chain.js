// The Tacit chain: hash-linked blocks of confidential notes, each anchored to an Ethereum transaction.
import { number, escapeHtml, shortId, ethAt, metrics } from '../format.js';

const plural = (n, word) => `${number(n)} ${word}${Number(n) === 1 ? '' : 's'}`;

export default {
  id: 'tacit-chain',
  sources: ['tacitChain'],
  render({ tacitChain: d }) {
    const rows = (d.blocks || []).slice(0, 8).map((b) => `<div class="row"><span class="row-key"><a href="#/chain/${b.height}"><span class="num">${number(b.height)}</span></a></span><span class="row-main"><strong>${plural(b.notes, 'note')} · ${number(b.spent)} spent${b.deposits ? ` · ${plural(b.deposits, 'deposit')}` : ''}</strong><span><code>${escapeHtml(shortId(b.hash, 6))}</code> · ${ethAt(b.ethBlock)}</span></span><span class="row-end"><a href="#/eth/${escapeHtml(b.tx)}"><code>${escapeHtml(shortId(b.tx, 4))}</code></a></span></div>`).join('');
    return {
      html: `<div class="rows">${rows || '<p class="empty">None returned.</p>'}</div>`,
      status: metrics([['Height', number(d.head?.height)]]),
      asOf: '',
      source: 'rebuilt here from Ethereum',
    };
  },
};
