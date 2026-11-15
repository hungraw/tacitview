// Burns on their way to Ethereum (/views/bridge-burns): each bridge burn in the recent Bitcoin blocks and the step
// it has reached. Steps: burned, confirmed (24 deep), relayed (Ethereum's relay is 24 past it), attested, minted.
import { number, escapeHtml, shortId, metrics, pill } from '../format.js';

const STEPS = ['Burned', 'Confirmed', 'Relayed', 'Attested', 'Minted'];
const STEP = 10; // rows added per "Show more"
const FIRST = 8; // rows shown before any "Show more"
let shownCount = FIRST, last = null;
const WAIT = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.4 5h.01M5 5h.01M7.6 5h.01" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
const TICK = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="m2.2 5.3 1.9 1.9 3.8-4.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function waited(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

function line(b, d) {
  if (b.step === 1) return `${b.confirmations} of ${d.confirmations} Bitcoin confirmations, about ${(d.confirmations - b.confirmations) * 10} min left.`;
  if (b.step === 2) return `Confirmed. Waiting for the relay on Ethereum to reach block ${number(b.height + d.confirmations)}.`;
  if (b.step === 3) return 'Relayed. Waiting for the next attestation.';
  if (b.step === 4) return 'Attested. Waiting for the mint on Ethereum.';
  return `Minted in <a href="#/eth/${escapeHtml(b.mintTx)}"><code>${escapeHtml(shortId(b.mintTx, 4))}</code></a>.`;
}

function row(b, d) {
  const dots = STEPS.map((name, i) => {
    const n = i + 1, state = n < b.step || b.step === 5 ? 'done' : n === b.step ? 'now' : 'todo';
    return `<span class="bj-step is-${state}" title="${name}"><span class="bj-dot">${state === 'done' ? TICK : state === 'now' ? WAIT : ''}</span></span>`;
  }).join('');
  const now = Date.now() / 1000;
  return `<div class="bj-row"><span class="bj-id"><a href="#/tx/${escapeHtml(b.txid)}"><code>${escapeHtml(shortId(b.txid, 4))}</code></a>${b.ticker ? `<small>${escapeHtml(b.ticker)}</small>` : ''}</span>
    <div class="bj-track"><div class="bj-steps" role="img" aria-label="${escapeHtml(STEPS[b.step - 1])}">${dots}</div><p class="bj-line">${line(b, d)}</p></div>
    <span class="bj-age num">${b.step === 5 ? 'Done' : waited(now - b.time)}</span></div>`;
}

function body(d) {
  const burns = d.burns || [];
  if (!burns.length) return `<p class="empty">No bridge burns in the last ${number(d.tip - d.windowFrom + 1)} Bitcoin blocks.</p>`;
  const waiting = burns.filter((b) => b.step < 5), minted = burns.filter((b) => b.step === 5);
  const ordered = [...waiting, ...minted.reverse()];
  const shown = ordered.slice(0, shownCount), rest = ordered.slice(shownCount);
  const head = `<div class="bj-row bj-head"><span>Burn</span><div class="bj-steps">${STEPS.map((x) => `<span class="bj-step-name">${x}</span>`).join('')}</div><span class="bj-age">Waiting</span></div>`;
  const heights = rest.map((b) => b.height);
  const expanded = shownCount > FIRST;
  const label = rest.length ? `${number(rest.length)} more in Bitcoin blocks ${number(Math.min(...heights))}–${number(Math.max(...heights))}` : `All ${number(ordered.length)} shown`;
  const buttons = [expanded && '<button type="button" class="bj-more-btn" data-bj-less>Show fewer</button>', rest.length && `<button type="button" class="bj-more-btn" data-bj-more>Show ${number(Math.min(STEP, rest.length))} more</button>`].filter(Boolean).join('');
  const more = rest.length || expanded ? `<div class="bj-more"><span>${label}</span><span class="bj-more-actions">${buttons}</span></div>` : '';
  const older = d.olderUnminted ? `<p class="note">(${pill(`${number(d.olderUnminted)} burn${d.olderUnminted === 1 ? '' : 's'}`, 'muted')} from before these blocks ${d.olderUnminted === 1 ? 'is' : 'are'} not minted yet)</p>` : '';
  return `<div class="bj" id="bj-root">${head}${shown.map((b) => row(b, d)).join('')}${more}${older}</div>`;
}

export default {
  id: 'bridge-burns',
  sources: ['bridgeBurns'],
  render({ bridgeBurns: d }) {
    last = d;
    return {
      html: body(d),
      status: metrics([d.typicalWait && ['Typical wait', waited(d.typicalWait)], d.ethBlock && ['Ethereum block', number(d.ethBlock), 'eth']]),
      about: d.typicalWait ? ['Typical wait', `The median time from burn to mint over the ${number(d.typicalOf)} minted burn${d.typicalOf === 1 ? '' : 's'} shown here. Mint times are estimated from their Ethereum block.`] : '',
      asOf: '',
      source: 'Bridge burn envelopes decoded here · ConfidentialPool nullifier logs · relay and pool heights',
    };
  },
};

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('click', (event) => {
    const more = event.target.closest('[data-bj-more]'), less = event.target.closest('[data-bj-less]');
    if ((!more && !less) || !last) return;
    shownCount = less ? FIRST : shownCount + STEP;
    const root = document.getElementById('bj-root');
    if (root) root.outerHTML = body(last);
    if (less) document.getElementById('bridge-burns')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}
