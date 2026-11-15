// Withdrawal check (/views/withdrawal-check): can an EVM pool withdrawal be tied to a deposit in plain sight, by the
// address it pays or by the wallet that sent it? By default the pool as a whole, counted by address; a looked-up
// address or transaction shows its verdict, the pairs behind it, and what would have kept it apart.
// #/check/<address or tx> opens the Ethereum page with that lookup made (the pills on EVM detail pages link there).
import { number, escapeHtml, shortId, formatUnits, relativeTime, pill } from '../format.js';

let query = '', result = null, busy = false, error = '';
let pinned = ''; // the #/check link last brought into view
// Address verdicts: the share of its withdrawals (paid to it, or sent by its wallet) tied to a deposit.
const VERDICT = {
  full: ['Fully linkable', 'warn'],
  partial: ['Partly linkable', 'warn'],
  nolink: ['No link found', 'muted'], // neutral, not green: amount and timing can still match (EVM-POOL.md)
  deposits: ['Deposits only', 'muted'],
  pending: ['Still reading', 'muted'],
};
// One withdrawal looked up by its transaction.
const TX_VERDICT = { linked: ['Linkable', 'warn'], nolink: ['No link found', 'muted'], pending: ['Still reading', 'muted'] };
const FEW = 3; // a withdrawal whose exact amount only this many deposits had before it stands out

function gap(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const m = Math.round(seconds / 60);
  if (m < 1) return 'Under 1 min';
  if (m < 60) return `${m} min`;
  if (m < 2880) return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
  return `${Math.round(m / 1440)} days`;
}
const eth = (wei) => `${formatUnits(wei, 18, 4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')} ETH`; // 4.0000 → 4
const addr = (a) => `<a href="#/address/${escapeHtml(a)}"><code data-addr="${escapeHtml(a)}">${escapeHtml(shortId(a, 4))}</code></a>`;
const row = (k, v, tone = '') => `<div class="row"><span class="row-main"><span>${k}</span></span><span class="row-end"><b class="num${tone ? ` is-${tone}` : ''}">${v}</b></span></div>`;
const plural = (n, word) => `${number(n)} ${word}${n === 1 ? '' : 's'}`;
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

function sentence(r, tx, missing, reading) {
  if (r.verdict === 'pending') {
    const what = missing ? `${number(missing)} recent senders are still being read` : reading?.length ? `the newest ${reading.map((c) => c.name).join(' and ')} blocks are still being read` : 'the newest blocks are still being read';
    return `No link found so far, but ${what}. Check again in a minute.`;
  }
  if (tx?.kind === 'withdrawal') {
    const what = `This ${eth(tx.amount)} withdrawal on ${escapeHtml(tx.name)} paid ${addr(tx.address)}`;
    if (tx.linkedBy === 'recipient') return `${what}, an address that had deposited before.`;
    if (tx.linkedBy === 'sender') return `${what}. It was sent by ${addr(tx.sender)}, not a relayer, and that wallet had deposited before.`;
    return `${what}${tx.relayed ? ' through a relayer' : ''}. Neither the address it paid nor the wallet that sent it had deposited before.`;
  }
  if (tx?.kind === 'deposit') {
    const what = `This ${eth(tx.amount)} deposit on ${escapeHtml(tx.name)} came from ${addr(tx.address)}`;
    if (r.verdict === 'full' || r.verdict === 'partial') return `${what}, and ${plural(r.linked, 'later withdrawal')} can be tied back to that wallet.`;
    return `${what}. No later withdrawal can be tied back to that wallet.`;
  }
  const who = addr(r.address), mine = r.withdrawals + r.sent;
  if (r.verdict === 'full') return `All ${plural(mine, 'withdrawal')} of ${who} can be tied to its deposits.`;
  if (r.verdict === 'partial') return `${number(r.linked)} of ${who}'s ${plural(mine, 'withdrawal')} can be tied to a deposit.`;
  if (r.verdict === 'nolink') return r.deposits ? `${who} was only paid before it first deposited, and never sent a withdrawal itself after.` : `${who} never deposited, and none of its withdrawals was sent by a wallet that did.`;
  if (r.verdict === 'deposits') return `${who} deposited but has not withdrawn.`;
  return `${who} has no EVM pool deposits or withdrawals.`;
}

// What would have kept these withdrawals apart, from what linked them and from the pool's own numbers.
function tips(res, tx, d) {
  const s = d.summary || {}, out = [];
  const byRecipient = tx?.linkedBy === 'recipient' || res.byRecipient > 0;
  const bySender = tx?.linkedBy === 'sender' || res.bySender > 0;
  if (byRecipient) out.push(`Withdraw to an address that has never deposited. ${number(s.fresh)} of the ${number(s.withdrew)} addresses paid by the pool never did.`);
  if (bySender || (tx?.kind === 'withdrawal' && !tx.relayed)) out.push(`Withdraw through Tacit's relay, so a relayer sends the transaction and your wallet never appears. ${pct(s.relayed, s.withdrawals)} of withdrawals do.`);
  if (tx?.kind === 'withdrawal' && tx.sameAmountBefore > 0 && tx.sameAmountBefore <= FEW) {
    const top = (d.common?.[tx.chain] || [])[0];
    out.push(`Only ${plural(tx.sameAmountBefore, 'deposit')} of exactly ${eth(tx.amount)} came before this one, so the amount alone narrows it to ${tx.sameAmountBefore === 1 ? 'one deposit' : 'a few'}.${top ? ` The most used amount on ${escapeHtml(tx.name)} is ${eth(top.amount)} (${plural(top.deposits, 'deposit')}).` : ''}`);
  }
  if (Number.isFinite(res.typicalGap) && res.typicalGap < 3600 && (res.verdict === 'full' || res.verdict === 'partial')) out.push(`Wait longer: these withdrawals came ${res.typicalGap < 60 ? 'within a minute of' : `a typical ${gap(res.typicalGap)} after`} the deposit; the sooner a withdrawal follows, the fewer deposits it can hide among.`);
  // A pill that opens the tips on hover or focus (the shared tooltip style), not a block of text in the card.
  return out.length ? `<p class="wc-tips"><span class="term wc-tip-pill" tabindex="0">How to stay unlinked<span class="tip" role="tooltip">${out.map((t) => `<span>${t}</span>`).join('')}</span></span></p>` : '';
}

function pairs(r) {
  if (!r.pairs?.length) return '';
  // One row per pair: deposit → withdrawal (each a link when its transaction is known), then how far apart and when.
  const side = (e, label) => (e.tx ? `<a href="#/eth/${escapeHtml(e.tx)}">${label}</a>` : label) + ` <b class="num">${eth(e.amount)}</b>`;
  return `<p class="mini-label">Latest linked pairs</p><div class="rows wc-pairs">${r.pairs.slice(0, 3).map((p) => `<div class="row"><span class="row-main"><span class="wc-pair">${p.dep ? side(p.dep, 'Deposit') : 'Deposit'}<i aria-hidden="true">→</i>${side(p.wd, 'Withdrawal')}${p.by === 'sender' ? '<em>by sender</em>' : ''}</span></span><span class="row-end">${p.dep ? `${gap(p.wd.time - p.dep.time)} apart · ` : ''}${relativeTime(p.wd.time)}</span></div>`).join('')}</div>`;
}

function resultHtml(d) {
  if (busy) return '<p class="empty">Checking…</p>';
  if (error) return `<p class="empty">${escapeHtml(error)}</p>`;
  const res = result?.result;
  if (!res) return '';
  if (res.verdict === 'invalid') return '<p class="empty">Enter an EVM address or a transaction hash.</p>';
  const tx = res.tx;
  if (tx && !tx.kind) return `<p class="empty">${tx.chain ? `This ${escapeHtml(tx.name)} transaction did not touch the EVM pool.` : 'No transaction with this hash on Ethereum, Base or Robinhood.'}</p>`;
  if (tx?.kind === 'transfer') return '<p class="empty">A private transfer inside the pool: no address on either side, nothing to link.</p>';
  const [label, tone] = (tx?.kind === 'withdrawal' ? TX_VERDICT[tx.verdict] : VERDICT[res.verdict]) || ['No activity', 'muted'];
  const few = tx?.kind === 'withdrawal' && tx.sameAmountBefore > 0 && tx.sameAmountBefore <= FEW;
  const rows = [
    tx?.kind === 'withdrawal' && row('Sent by', tx.relayed ? 'a relayer' : addr(tx.sender)),
    tx?.kind === 'withdrawal' && row(`Deposits of exactly ${eth(tx.amount)} before it`, few ? `${number(tx.sameAmountBefore)} · few` : number(tx.sameAmountBefore), few ? 'warn' : ''),
    !tx && row('Deposits', number(res.deposits)),
    !tx && row('Withdrawals paid to it', number(res.withdrawals)),
    !tx && res.sent > 0 && row('Withdrawals its wallet sent elsewhere', number(res.sent)),
    !tx && (res.verdict === 'full' || res.verdict === 'partial') && row('Tied to a deposit', `${number(res.linked)}${res.bySender ? ` · ${number(res.bySender)} by sender` : ''}`),
    !tx && res.linked > 0 && row('Usual wait before withdrawing', gap(res.typicalGap)),
  ].filter(Boolean).join('');
  return `<p class="wc-verdict">${pill(label, tone)} ${sentence(res, tx, result.missingSenders, result.reading)}</p><div class="rows">${rows}</div>${tx ? '' : pairs(res)}${tips(res, tx, d)}`;
}

function summaryHtml(d) {
  const s = d.summary || {};
  // Say what is still loading: a chain's blocks after the snapshot, or recent senders. Counts may still move.
  const chains = (d.reading || []).map((c) => `${escapeHtml(c.name)} after block ${number(c.after)}`);
  const reading = chains.length ? `<p class="note">Reading ${chains.join(', ')}; the counts settle in a minute or two.</p>` : d.missingSenders ? `<p class="note">Reading ${number(d.missingSenders)} recent senders; the counts settle in a minute or two.</p>` : '';
  // Most linked withdrawals come from a few addresses looping deposit → withdrawal; say how many, as counts.
  const loops = s.heavy ? `<p class="note">${number(s.heavy)} address${s.heavy === 1 ? '' : 'es'} with over ${number(s.heavyAt)} linked withdrawals each account for ${pct(s.heavyLinked, s.linkedWithdrawals)} of the ${number(s.linkedWithdrawals)} linked withdrawals.</p>` : '';
  return `<div class="rows">${row('Addresses paid by the pool', number(s.withdrew))}${row('No link found', number(s.fresh))}${row('Linkable to a deposit', number(s.linked))}</div>${loops}${reading}`;
}

function body(d) {
  const filled = query ? ` value="${escapeHtml(query)}"` : '';
  const done = result || busy || error;
  return `<form class="wc-form" data-wc-form autocomplete="off"><input name="q" class="wc-input" placeholder="Withdrawal tx or address" spellcheck="false" aria-label="EVM address or transaction hash"${filled}><button type="${done ? 'button' : 'submit'}" class="wc-btn" ${done ? 'data-wc-clear' : ''}>${done ? 'Clear' : 'Check'}</button></form>
    <div id="wc-out">${query ? resultHtml(d) : summaryHtml(d)}</div>`;
}

// #/check/<q>: put the card at the top of the screen at once, and keep it there for a few seconds while the cards
// above it load and change height (scroll-margin-top clears the sticky header).
function pin(ms = 10_000) {
  const card = document.getElementById('withdrawal-check'), page = document.getElementById('page');
  if (!card || !page) return;
  // An instant jump (the page scrolls smoothly by default, which would restart on every realign).
  const align = () => { const top = card.getBoundingClientRect().top + window.scrollY - (Number.parseFloat(getComputedStyle(card).scrollMarginTop) || 0); if (Math.abs(top - window.scrollY) > 2) window.scrollTo({ top, behavior: 'instant' }); };
  align();
  const watch = new ResizeObserver(align);
  watch.observe(page);
  const stop = () => { clearInterval(done); watch.disconnect(); window.removeEventListener('wheel', stop); window.removeEventListener('touchstart', stop); window.removeEventListener('keydown', stop); };
  // Realign as the page grows (cards below must load before the card can reach the top) until every card has drawn
  // and a second has passed, or ms; the reader scrolling takes over at once.
  const started = Date.now();
  let settledAt = 0;
  const done = setInterval(() => {
    align();
    if (page.querySelector('.skeleton')) settledAt = 0; else settledAt ||= Date.now();
    if ((settledAt && Date.now() - settledAt > 1_000) || Date.now() - started > ms) stop();
  }, 200);
  window.addEventListener('wheel', stop, { passive: true }); window.addEventListener('touchstart', stop, { passive: true }); window.addEventListener('keydown', stop);
}

let last = null;
async function run(q) {
  query = String(q || '').trim();
  if (!query) return;
  busy = true; error = ''; result = null; redraw();
  try {
    const res = await fetch(`/api/views/withdrawal-check?q=${encodeURIComponent(query.toLowerCase())}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(res.status === 504 ? 'The check took too long. Try again in a moment.' : `The check failed (HTTP ${res.status}).`);
    const j = await res.json();
    result = j.data || j;
  } catch (e) { error = e.message; }
  busy = false; redraw();
}
function redraw() {
  const root = document.getElementById('withdrawal-check-body');
  if (root && last) root.innerHTML = body(last);
}

export default {
  id: 'withdrawal-check',
  sources: ['withdrawalCheck'],
  render({ withdrawalCheck: d }) {
    last = d;
    // #/check/<q>: make that lookup once, then bring the card into view.
    const m = typeof location !== 'undefined' && /^#\/check\/(.+)$/.exec(location.hash);
    if (!m) pinned = '';
    if (m) {
      const q = decodeURIComponent(m[1]).trim();
      if (q && location.hash !== pinned) { pinned = location.hash; setTimeout(() => { if (q !== query || !result) run(q); pin(); }, 0); }
    }
    const s = d.summary || {};
    return {
      html: body(d),
      status: s.since === 'deploy' ? '' : '<span class="muted">Last 24 h</span>',
      about: ['Withdrawal check', 'The pool hides which deposit pays a withdrawal, but two public facts can give it away: the withdrawal pays an address that deposited before, or it was sent by a wallet that deposited before (no relayer). Counted by address: a few addresses loop deposits and withdrawals thousands of times, which would swamp a count of withdrawals.'],
      asOf: '',
      source: 'EVM pool Transact logs since deploy · deposit and withdrawal senders',
    };
  },
};

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('submit', (event) => {
    const form = event.target.closest?.('[data-wc-form]');
    if (!form) return;
    event.preventDefault();
    run(form.elements.q.value);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-wc-clear]')) return;
    query = ''; result = null; error = ''; busy = false;
    if (/^#\/check\//.test(location.hash)) history.replaceState(null, '', '#/ethereum');
    pinned = '';
    redraw();
  });
}
