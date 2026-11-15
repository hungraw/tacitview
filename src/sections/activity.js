// Newest EVM pool events across chains (/views/evm-activity), read from the pool's Transact logs: each deposit with
// the address that sent it, each withdrawal with the address it paid, and a link to the transaction.
import { escapeHtml, shortId, formatUnits, relativeTime, chainBadge } from '../format.js';

const KIND = { deposit: 'Deposit', withdrawal: 'Withdrawal', transfer: 'Private transfer' };
const BADGE = { 1: 'eth', 8453: 'base', 4663: 'rh' };

export default {
  id: 'activity',
  sources: ['evmActivity'],
  render({ evmActivity: d }) {
    const rows = (d.rows || []).slice(0, 6).map((r) => `<div class="row act-row"><span class="row-main"><span class="act-title"><strong>${escapeHtml(KIND[r.kind] || r.kind)}</strong>${r.address ? `<span class="muted">${r.kind === 'deposit' ? 'from' : 'to'}</span><span class="act-addr"><code data-addr="${escapeHtml(r.address)}">${escapeHtml(shortId(r.address, 4))}</code></span>` : ''}</span><span class="act-meta">${chainBadge(BADGE[r.chain] || 'eth', 'sm')}<span>${escapeHtml(r.name)} · <a href="#/eth/${escapeHtml(r.tx)}">${relativeTime(r.time)}</a></span></span></span><span class="row-end"><b class="num">${r.kind === 'transfer' ? 'hidden' : `${formatUnits(r.eth, 18, 3)} ETH`}</b></span></div>`).join('');
    return {
      html: `<div class="rows">${rows || '<p class="empty">No EVM pool events in the last day.</p>'}</div>`,
      asOf: '',
      source: 'EVM pool Transact logs · deposit transactions',
    };
  },
};
