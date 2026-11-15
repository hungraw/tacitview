// EVM pool per chain (Ethereum, Base, Robinhood): counts from the pool's own Transact logs since deploy, balances read
// from each chain (/views/evm-pools).
import { number, escapeHtml, formatUnits, relativeTime, chainName, chainBadge, pill } from '../format.js';

const BADGE = { 1: 'eth', 8453: 'base', 4663: 'rh' };

export default {
  id: 'evm-pools',
  sources: ['evmPools'],
  render({ evmPools: d }) {
    // One line per chain, so the Withdrawal check fits under this card beside the activity list.
    const rows = (d.chains || []).map((r) => `<div class="row evm-row">${chainBadge(BADGE[r.chain] || 'eth', 'sm')}<span class="row-main"><span class="evm-line"><strong>${escapeHtml(r.name || chainName(r.chain))}</strong><span title="Deposits in · withdrawals out${r.lastAt ? ' · last event' : ''}">${number(r.depositCount)} in · ${number(r.withdrawalCount)} out${r.lastAt ? ` · ${relativeTime(r.lastAt)}` : ''}</span></span></span><span class="row-end"><b class="num" title="Read from the chain">${r.balanceWei == null ? '—' : `${formatUnits(r.balanceWei, 18, 4)} ETH`}</b></span></div>`).join('');
    return {
      html: `<div class="rows">${rows || '<p class="empty">No chains returned.</p>'}</div>`,
      status: d.asOf.partial ? pill('Reading', 'muted', 'Newest blocks of a chain are still being read; its counts stop at the snapshot') : '',
      asOf: '',
      source: 'Transact logs · pool 0x000000c2…AFBEE9',
    };
  },
};
