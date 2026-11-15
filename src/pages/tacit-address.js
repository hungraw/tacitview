// Tacit (shielded) address page. The address itself is public and decodes to its keys. Its balance and amounts are
// not on any chain in the clear, so the page shows the usual layout redacted. Its plain Bitcoin address is public and
// linked, and the copy says so: on Bitcoin, Tacit's app pays that address by default and stealth is opt-in (tcs1…);
// pool payments to others are stealth locks (Tacit docs/BUILD-A-TACIT-DAPP.md).
import { escapeHtml, chainBadge } from '../format.js';
import { pageHead } from './common.js';

const EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 20 20 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

const LOCK = '<span class="addr-lock" role="img" aria-label="Private address" title="Private address: balances and amounts are not public"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></span>';

const row = ([k, v]) => `<div class="kvrow"><span>${escapeHtml(k)}</span><span>${k === 'Bitcoin address' ? `<a href="#/address/${escapeHtml(v)}"><code>${escapeHtml(v)}</code></a>` : `<code>${escapeHtml(String(v))}</code>`}</span></div>`;
const LONG = new Set(['Lanes', 'Pool address']); // wide values go in the full-width part of the L

export function renderTacitAddress(d) {
  const rows = (d.items.find((i) => i.title === 'Unified Tacit address')?.rows || []).filter(([k, v]) => v != null && k !== 'Flags');
  const short = rows.filter(([k]) => !LONG.has(k)), wide = rows.filter(([k]) => LONG.has(k));
  return [
    pageHead({ crumbs: [['Overview', '#/'], ['Tacit address']], title: 'Tacit address', about: ['What stays private here', "Amounts paid to this address are encrypted either way. Paid on Bitcoin from Tacit's app, a note lands on the plain Bitcoin address below: public, and linked to this address. Stealth on Bitcoin is opt-in, through a separate tcs1 address, and a stealth output looks like any fresh address, so this explorer cannot tell which payments were stealth. Paid in the Ethereum pool, a note arrives as a stealth lock and is not linked to this address."], id: d.query, idShort: 12, idAfter: LOCK, icon: chainBadge('tacit', 'lg') }),
    // Redacted box beside the short facts, wide facts underneath both: the facts form an L around it.
    `<div class="tacit-grid${wide.length ? '' : ' no-wide'}">
    <section class="vault" tabindex="0" aria-label="Tacit balance and amounts of this address">
      <div class="vault-ghost" aria-hidden="true">
        <div class="card"><p class="mini-label">Balance</p><p class="bal-big num scramble"></p>
          <svg class="bal-chart" viewBox="0 0 640 150" preserveAspectRatio="none"><path class="line" d="M6,120H90V80H180V100H270V50H380V64H470V30H634"/></svg>
          <i class="ghost-bar" style="--w:70%"></i><i class="ghost-bar" style="--w:40%"></i></div>
      </div>
      <div class="vault-veil"><div class="vault-msg"><span class="vault-eye">${EYE_OFF}</span>
        <span class="vault-ask"><b><span class="on-hover">Hover to view</span><span class="on-touch">Tap to view</span></b><span>Tacit balance and amounts</span></span>
        <span class="vault-answer"><b>Nothing to see here.</b><span>That's the point. Tacit balances and amounts for this address are not on any chain in the clear. Its plain Bitcoin address is public, with every envelope it signs.</span></span>
      </div></div>
    </section>
    <section class="card kvtable l-top">${short.map(row).join('')}</section>
    ${wide.length ? `<section class="card kvtable l-bottom">${wide.map(row).join('')}</section>` : ''}
    </div>`,
  ].join('');
}
