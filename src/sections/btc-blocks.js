// Recent Bitcoin blocks as tiles, coloured by where each block stands in the bridge to Ethereum.
import { number, escapeHtml, clock, term, btcAt, metrics } from '../format.js';

const LABEL = { attested: 'attested to Ethereum', eligible: 'awaiting reflection', confirming: 'confirming' };

export default {
  id: 'btc-blocks',
  sources: ['btcBlocks'],
  render({ btcBlocks: d }) {
    // Enough tiles to reach past the attested height in the usual case, so the crossing is visible.
    const blocks = (d.blocks || []).slice(0, 36); // 6 rows of 6
    const tiles = blocks.map((b) => {
      const n = b.envelopes?.length || 0;
      const loading = /still loading/.test(b.error || '');
      const ops = loading ? '<i class="decoding" aria-hidden="true"></i>' : b.error ? '…' : n ? `${n} op${n === 1 ? '' : 's'}` : '';
      const title = `Block ${number(b.height)} · ${LABEL[b.bridge] || 'unknown'} · ${number(b.confirmations)} conf · ${loading ? 'decoding the raw block' : b.error ? 'could not decode yet' : `${n} Tacit envelope${n === 1 ? '' : 's'}`}`;
      return `<a class="tile tile-btc is-${b.bridge}" data-key="${b.height}" href="#/block/${b.height}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"><span class="tile-num">${String(b.height).slice(-3)}</span><span class="tile-ops">${ops}</span></a>`;
    }).join('');
    const count = (s) => blocks.filter((b) => b.bridge === s).length;
    return {
      html: `<div class="tiles tiles-6">${tiles}</div><ul class="legend">
        <li><i class="key tile-btc is-confirming"></i>${term('Confirming')} <b>${count('confirming')}</b></li>
        <li><i class="key tile-btc is-eligible"></i>${term('Awaiting reflection', 'awaiting')} <b>${count('eligible')}</b></li>
        <li><i class="key tile-btc is-attested"></i>${term('Attested')} <b>${count('attested')}</b></li></ul>`,
      status: metrics([['Bitcoin tip', number(d.asOf.tip), 'btc']]),
      asOf: '',
      source: 'raw blocks, decoded here',
    };
  },
};
