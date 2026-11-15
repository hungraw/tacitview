// The withdrawal-check verdict as a pill on EVM detail pages (an EVM pool transaction, an EVM address). The page
// renders a placeholder; the verdict is fetched after it and links to the full check on the Ethereum page.
import { escapeHtml, number } from './format.js';

const LABEL = {
  full: ['Fully linkable', 'warn'],
  partial: ['Partly linkable', 'warn'],
  nolink: ['No link found', 'muted'],
  linked: ['Linkable', 'warn'], // one withdrawal, looked up by its transaction
};

function note(r) {
  const tx = r.tx;
  if (tx?.kind === 'withdrawal') return tx.linkedBy === 'recipient' ? 'Paid an address that had deposited before' : tx.linkedBy === 'sender' ? 'Sent by a wallet that had deposited before' : 'Neither the address paid nor the sending wallet had deposited before';
  const mine = (r.withdrawals || 0) + (r.sent || 0);
  if (r.verdict === 'full') return `All ${number(mine)} of its withdrawals tie to its deposits`;
  if (r.verdict === 'partial') return `${number(r.linked)} of ${number(mine)} withdrawals tie to a deposit`;
  if (r.verdict === 'nolink') return 'No withdrawal ties to a deposit by address or sender';
  return '';
}

// `q` is the address or transaction hash; `withNote` adds the one-line reason after the pill.
export function exposureSlot(q, { withNote = false } = {}) {
  const key = String(q || '').toLowerCase();
  if (!/^0x([0-9a-f]{40}|[0-9a-f]{64})$/.test(key)) return '';
  setTimeout(() => fill(key, withNote), 0);
  return `<span class="exposure" data-exposure="${escapeHtml(key)}"></span>`;
}

async function fill(key, withNote) {
  let r = null;
  try {
    const res = await fetch(`/api/views/withdrawal-check?q=${encodeURIComponent(key)}`, { headers: { accept: 'application/json' } });
    if (res.ok) { const j = await res.json(); r = (j.data || j).result; }
  } catch { /* no pill */ }
  const verdict = r?.tx?.kind === 'withdrawal' ? r.tx.verdict : r?.tx ? null : r?.verdict; // a deposit tx gets no pill
  const [label, tone] = LABEL[verdict] || [];
  for (const slot of document.querySelectorAll(`[data-exposure="${key}"]`)) {
    if (!label) { slot.remove(); continue; }
    const why = note(r);
    slot.innerHTML = `<a class="pill is-${tone} exposure-pill" href="#/check/${escapeHtml(key)}" title="${escapeHtml(why ? `${why}. Open the withdrawal check.` : 'Open the withdrawal check')}">${escapeHtml(label)}</a>${withNote && why ? `<span class="exposure-note">${escapeHtml(why)}</span>` : ''}`;
  }
}
