// EVM transaction page (/views/eth-tx).
import { escapeHtml, number, shortId, link, formatUnits, relativeTime, siteLink, timePill, chainBadge, POOL_EVENT, pill, metrics } from '../format.js';
import { pageHead, kvTable, privacyPanel } from './common.js';
import { exposureSlot } from '../exposure.js';


// One step per pool event. Sentence case throughout; the log index is not shown (it is in the event list).
function eventCard(e, burns = new Map()) {
  // A bridge mint spends the nullifier its Bitcoin burn published: that spend is public, not hidden. burns maps
  // ν -> the Bitcoin burn (or null when this server has not seen that burn yet).
  if (e.type === 'nullifiers' && (e.nullifiers || []).length && e.nullifiers.every((n) => burns.has(String(n).toLowerCase()))) {
    const burn = burns.get(String(e.nullifiers[0]).toLowerCase());
    return `<div class="flow-step"><strong class="btc">Bitcoin burn minted</strong><span>${burn ? `Burn <a href="#/tx/${escapeHtml(burn.txid)}"><code>${escapeHtml(shortId(burn.txid, 6))}</code></a>${burn.height ? ` · block ${number(burn.height)}` : ''}` : `Nullifier <code>${escapeHtml(shortId(e.nullifiers[0], 8))}</code>`}${e.nullifiers.length > 1 ? ` +${e.nullifiers.length - 1}` : ''}</span><span>Published by the burn on Bitcoin, so this spend is public</span></div>`;
  }
  if (e.type === 'nullifiers') {
    return `<div class="flow-step"><strong class="eth">Note spent</strong><span>Nullifier <code>${escapeHtml(shortId(e.nullifiers?.[0], 8))}</code>${e.nullifiers?.length > 1 ? ` +${e.nullifiers.length - 1}` : ''}</span><span class="hidden-line"><i class="redact" aria-hidden="true"></i>Which note it spent is hidden, for an owned note</span></div>`;
  }
  if (e.type === 'leaves') {
    return `<div class="flow-step is-created"><strong class="eth">Note created</strong><span>Leaf #${number(e.leafIndex)} <code>${escapeHtml(shortId(e.leaves?.[0], 8))}</code>${e.leaves?.length > 1 ? ` +${e.leaves.length - 1}` : ''}</span><span class="hidden-line"><i class="redact" aria-hidden="true"></i>Amount and owner hidden${e.memoBytes?.[0] ? ` · ${number(e.memoBytes[0])}-byte encrypted memo` : ''}</span></div>`;
  }
  const name = POOL_EVENT[e.type] || e.type;
  return `<div class="flow-step"><strong>${escapeHtml(name.charAt(0).toUpperCase() + name.slice(1))}</strong></div>`;
}

const arrow = '<svg class="flow-arrow" width="48" height="24" viewBox="0 0 48 24" aria-hidden="true"><path d="M4 12h32" stroke="currentColor" stroke-width="1.5"/><path d="M30 6l8 6-8 6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

// What the logs present keep hidden (SPEC §11): only what this transaction's own events create or spend.
function hiddenFor(counts) {
  const out = [];
  if (counts.spent) out.push("which earlier note was spent (owned notes only: a bearer or Bitcoin-homed note's spend can be matched to its leaf)");
  if (counts.created) out.push('amounts of the notes created', 'who owns the new notes (the memo is encrypted to them)');
  return out.length ? out : ['nothing in these logs: this transaction creates and spends no note'];
}

// A Wrap amount in its token's units when the server matched the token (detail.cjs withWrapToken), else base units.
const wrapAmount = (e) => (e.token ? `${formatUnits(e.amount, e.token.decimals, 8)} ${e.token.symbol}` : `${e.amount} base units of asset ${shortId(e.assetId, 4)}`);

// What the settle call published, one row per kind present. Payout amounts come from the matching token Transfer;
// values without one are the pool's in-system units.
const plural = (n, one, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;
const addrLink = (a) => `<a href="#/address/${escapeHtml(a)}"><code data-addr="${escapeHtml(a)}">${escapeHtml(shortId(a, 4))}</code></a>`;
const paid = (x) => (x.paid ? `${formatUnits(x.paid.amount, x.paid.decimals, 6)} ${escapeHtml(x.paid.symbol)}` : `${number(x.value)} units of asset <code>${escapeHtml(shortId(x.assetId, 4))}</code>`);
const reserves = (x) => `Pool <code>${escapeHtml(shortId(x.poolId, 4))}</code>: reserves ${number(x.aPre)} → ${number(x.aPost)} and ${number(x.bPre)} → ${number(x.bPost)}`;

// The Tacit chain block that anchors this transaction, as the last step of the flow.
const chainStep = (d) => (d.chainBlock
  ? `<div class="flow-step is-chain"><strong><a href="#/chain/${d.chainBlock.height}">Tacit chain block ${number(d.chainBlock.height)}</a></strong><span>Hash <code>${escapeHtml(shortId(d.chainBlock.hash, 8))}</code></span><span>${number(d.chainBlock.notes)} note${d.chainBlock.notes === 1 ? '' : 's'} created · ${number(d.chainBlock.spent)} spent</span></div>`
  : `<div class="flow-step is-unanchored"><strong>Tacit chain block</strong><span>Not among the ${escapeHtml(d.chainBlockSearched || 'recent blocks')}</span></div>`);

// Settlement: the steps the logs show (notes spent and created, then the anchoring Tacit chain block), and under
// them everything else the settle call made public.
function settlementCard(d, events) {
  const s = d.settlement;
  const burns = new Map((s.burnNullifiers || []).map((n) => [String(n).toLowerCase(), (s.burns || []).find((b) => b.nullifier === n)?.burn || null]));
  const steps = [...events.filter((e) => e.type !== 'wrap').map((e) => eventCard(e, burns))];
  // A claimed stealth payment spends a lock nullifier, which has no event: the decoded call says how many.
  if (s.lockNullifiers) steps.unshift(`<div class="flow-step"><strong class="eth">Lock spent</strong><span>${plural(s.lockNullifiers, 'lock nullifier')} in the settle call</span><span class="hidden-line"><i class="redact" aria-hidden="true"></i>Claimed or refunded; who spent it is hidden</span></div>`);
  const flow = [...steps, chainStep(d)].filter(Boolean).join(arrow);
  // Same rows as the details table below; everything listed here is public, so no tag is needed.
  const row = (label, value) => `<div class="kvrow"><span>${label}</span><span>${value}</span></div>`;
  const PUBLIC = '';
  const rows = [
    s.deposits && row('Deposits used', [plural(s.deposits, 'deposit'), ...events.filter((e) => e.type === 'wrap').map(wrapAmount)].join(' · '), PUBLIC),
    ...s.withdrawals.map((w) => row('Withdrawal', `${paid(w)} to ${addrLink(w.recipient)}`, PUBLIC)),
    ...s.fees.map((f) => row('Fee', `${paid(f)} to the sender of this transaction`, PUBLIC)),
    ...s.swaps.map((x) => row('Swap', reserves(x), PUBLIC)),
    ...s.liquidity.map((x) => row('Liquidity', `${reserves(x)}; shares ${number(x.sharesPre)} → ${number(x.sharesPost)}`, PUBLIC)),
    // Each minted burn already has its own step above; the row only covers burns the logs did not show.
    s.burnsMinted > burns.size && row('Bitcoin burns minted', plural(s.burnsMinted, 'burn'), PUBLIC),
    s.crossOuts && row('Cross-outs to Bitcoin', plural(s.crossOuts, 'note'), PUBLIC),
    s.lockLeaves && row('Locks created', `${plural(s.lockLeaves, 'lock')}, owners hidden`, PUBLIC),
    s.loans && row('Loans', `${plural(s.loans, 'position')} opened, closed or changed`, PUBLIC),
    ...s.cbtcMints.map((x) => row('cBTC minted', `against a ${number(x.sats)}-sat lock`, PUBLIC)),
    s.harvests && row('Farm rewards', plural(s.harvests, 'harvest'), PUBLIC),
  ].filter(Boolean).join('');
  return `<section class="card"><header class="card-head"><h2>Settlement</h2><span class="card-head-end"><span class="status">${metrics([s.batches > 1 && ['Batches', number(s.batches)], ['Logs', number(d.logCount)]])}</span></span></header>
    ${flow ? `<div class="flow">${flow}</div>` : ''}${rows ? `<div class="st">${rows}</div>` : ''}</section>`;
}

export function renderEthTx(d) {
  const events = d.poolEvents || [];
  // Nullifiers a bridge mint spends were published by their Bitcoin burn: public, not "which note" hidden.
  const burnSet = new Set((d.settlement?.burnNullifiers || []).map((n) => String(n).toLowerCase()));
  const isBurn = (e) => (e.nullifiers || []).length && e.nullifiers.every((n) => burnSet.has(String(n).toLowerCase()));
  const counts = { spent: events.filter((e) => e.type === 'nullifiers' && !isBurn(e)).length, created: events.filter((e) => e.type === 'leaves').length, burns: d.settlement?.burnsMinted || 0 };
  const chips = [[d.chainName, 'eth'], ...(d.touched.length ? [[d.touched.join(' · '), 'eth']] : [['Not a Tacit transaction', '']]), [d.status === 'success' ? 'Success' : d.status === 'reverted' ? 'Reverted' : String(d.status || '').charAt(0).toUpperCase() + String(d.status || '').slice(1), d.status === 'success' ? 'ok' : 'bad']];
  const flow = d.settlement ? settlementCard(d, events) : d.touched.includes('ConfidentialPool') ? `<section class="card"><header class="card-head"><h2>What this transaction did</h2><span class="status">${number(d.logCount)} logs</span></header>
<div class="flow">${[...events.map(eventCard), d.chainBlock ? `<a class="flow-step is-chain" href="#/chain/${d.chainBlock.height}"><strong>Tacit chain block ${number(d.chainBlock.height)}</strong><span>hash <code>${escapeHtml(shortId(d.chainBlock.hash, 8))}</code></span><span>${number(d.chainBlock.notes)} note${d.chainBlock.notes === 1 ? '' : 's'} · ${number(d.chainBlock.spent)} spent</span><small>open block</small></a>` : ''].filter(Boolean).join(arrow)}</div>${d.chainBlock ? '' : `<p class="note">No Tacit chain block anchors this transaction among the ${escapeHtml(d.chainBlockSearched || 'recent blocks')}.</p>`}</section>` : '';
  return [
    pageHead({ crumbs: [[d.chainName, '#/'], d.toName ? [d.toName] : ['Contract'], ['Transaction']], title: 'Transaction', id: d.hash, chips, chipsAfter: d.touched.some((n) => /^EVM pool/.test(n)) ? exposureSlot(d.hash) : '', icon: chainBadge({ 1: 'eth', 8453: 'base', 4663: 'rh' }[d.chain] || 'eth', 'lg'), links: [siteLink(d.explorer, d.chain === 1 ? 'Etherscan' : 'block explorer')] }),
    flow,
    `<div class="grid grid-3-2">`,
    kvTable([
      ['Status', d.status === 'success' ? 'Success' : 'Reverted'],
      ['Block', number(d.block), { mono: true }],
      ['Time', timePill(d.time)],
      ['From', `<a href="#/address/${escapeHtml(d.from)}"><code data-addr="${escapeHtml(d.from)}">${escapeHtml(d.from)}</code></a>`],
      ['To', `<a href="#/address/${escapeHtml(d.to)}"><code data-addr="${escapeHtml(d.to)}">${escapeHtml(d.to)}</code></a>`],
      ['Tacit contracts', d.touched.length ? escapeHtml(d.touched.join(', ')) : 'none'],
      ['Gas used', `${number(d.gasUsed)}${d.gasPriceWei ? ` · ${formatUnits(d.gasPriceWei, 9, 4)} gwei` : ''}`, { mono: true }],
      d.feeWei && ['Fee', `${formatUnits(d.feeWei, 18, 7)} ETH`, { mono: true }],
    ]),
    d.touched.includes('ConfidentialPool')
      ? privacyPanel(
        [['sender', d.fromName ? `${d.fromName} (a relayed transaction: the user's own address is not the sender)` : `${shortId(d.from, 4)} (public)`], ...(counts.spent ? [['nullifiers', String(counts.spent)]] : []), ...(counts.burns ? [['Bitcoin burns minted', `${counts.burns} (nullifier published on Bitcoin)`]] : []), ...(counts.created ? [['new leaves', String(counts.created)]] : []),
          ...events.filter((e) => e.type === 'wrap').map((e) => ['Wrap amount (public)', wrapAmount(e)]), ['gas and time', 'yes']],
        hiddenFor(counts),

      )
      : privacyPanel([['everything', 'public EVM transaction']], ['nothing hidden by Tacit here']),
    `</div>`,
  ].join('');
}
