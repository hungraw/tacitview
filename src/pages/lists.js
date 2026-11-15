// Paged lists: Tacit chain, Bitcoin blocks, ConfidentialPool events.
import { escapeHtml, number, shortId, relativeTime, term, assetIcon, assetName, TERMS, POOL_EVENT, link } from '../format.js';
import { pageHead, pagination, copyIcon } from './common.js';
import { filterBar, sortTh } from '../filters.js';
import { activityCard, fillActivity } from '../activity-strip.js';

const tally = (list, fn) => list.reduce((m, x) => { for (const t of [fn(x)].flat()) if (t) m[t] = (m[t] || 0) + 1; return m; }, {});

const VERIFY = { verified: ['Match', 'ok'], mismatch: ['Differs', 'bad'], unverifiable: ['Not yet', ''] };
// Pages of 20 counted down from the newest height: page k starts at head − 20·(k − 1); page 1 is the live list.
const PAGE = 20;
const pages = (base, head, from) => ({
  page: Math.floor((head - from) / PAGE) + 1,
  pages: Math.floor(head / PAGE) + 1,
  href: (k) => (k === 1 ? `#/${base}` : `#/${base}/${head - PAGE * (k - 1)}`),
});

export function renderChainList(d) {
  const tokens = (b) => [b.notes > 0 ? 'creates' : b.spent > 0 ? 'spendonly' : '', b.deposits ? 'deposit' : '', VERIFY[b.verification] ? b.verification : 'unverifiable'];
  const rows = d.blocks.map((b) => {
    const [label, tone] = VERIFY[b.verification] || VERIFY.unverifiable;
    return `<tr data-key="${b.height}" data-f="${tokens(b).filter(Boolean).join(' ')}"><th scope="row"><a href="#/chain/${b.height}"><span class="num">${number(b.height)}</span></a></th><td data-s="${b.notes * 1000 + b.spent}">${number(b.notes)} note${b.notes === 1 ? '' : 's'} · ${number(b.spent)} spent${b.deposits ? ` · ${number(b.deposits)} deposit${b.deposits === 1 ? '' : 's'}` : ''}</td><td><span class="hash-cell"><code>${escapeHtml(shortId(b.hash, 6))}</code>${copyIcon(b.hash, 'block hash')}</span></td><td data-s="${b.ethBlock}"><span class="hash-cell"><a href="#/eth/${escapeHtml(b.tx)}"><code>${escapeHtml(shortId(b.tx, 5))}</code></a>${copyIcon(b.tx, 'Ethereum transaction hash')}</span> · ${number(b.ethBlock)}</td><td><span class="chip ${tone}"${b.verificationNote ? ` title="${escapeHtml(b.verificationNote)}"` : ''}>${label}</span></td></tr>`;
  }).join('');
  const newer = d.head && d.from < d.head ? `#/tacit-chain/${Math.min(d.head, d.from + 20)}` : null;
  const t = tally(d.blocks, tokens);
  const bar = filterBar('tacit-chain', { total: d.blocks.length, groups: [
    { name: 'contents', label: 'Contents', options: [['creates', 'Creates notes', t.creates], ['spendonly', 'Spends only', t.spendonly], ['deposit', 'With deposits', t.deposit]] },
    { name: 'check', label: 'Same as Tacit', all: 'Any', options: [['verified', 'Match', t.verified], ['mismatch', 'Differs', t.mismatch], ['unverifiable', 'Not yet', t.unverifiable]] },
  ] });
  const newest = !d.head || d.from >= d.head; // the strip belongs to the newest page only
  // Each block names its parent's hash: on this page, check every one against the block listed below it.
  const pairs = d.blocks.slice(0, -1).filter((b, i) => b.prev && d.blocks[i + 1].height === b.height - 1);
  const linked = pairs.filter((b) => String(b.prev).toLowerCase() === String(d.blocks[d.blocks.indexOf(b) + 1].hash).toLowerCase()).length;
  if (newest) fillActivity();
  return pageHead({ crumbs: [['Overview', '#/'], ['Tacit chain']], title: 'Tacit chain', chips: [[`Height ${number(d.head)}`, 'eth'], ...(pairs.length && linked !== pairs.length ? [[`${pairs.length - linked} parent link${pairs.length - linked === 1 ? '' : 's'} broken`, 'bad']] : [])], about: ['How these blocks are checked', "On this site's server, each block's hash is rebuilt from its anchoring Ethereum transaction's logs and the parent hash Tacit published, then compared with the hash Tacit publishes. Your browser then checks that each parent hash equals the hash of the block below it. A block's page can repeat the hash check in your browser."] })
    + (newest ? activityCard() : '')
    + `<section class="card">${bar}<div class="table-wrap"><table class="table"><thead><tr>${sortTh('Height')}${sortTh('Contents')}<th scope="col">Hash</th>${sortTh('Anchored in · Ethereum block')}${sortTh('Same as Tacit', 'text')}</tr></thead><tbody>${rows}</tbody></table></div>${d.head ? pagination(pages('tacit-chain', d.head, d.from ?? d.head)) : pagination({ prev: newer, next: d.next != null ? `#/tacit-chain/${d.next}` : null })}</section>`;
}

const STATE = { attested: 'Attested', eligible: 'Awaiting reflection', confirming: 'Confirming' };
// A block's envelopes as one chip per op and ticker, with a count ("bridge burn TAC ×7"); the block page lists each.
function opChips(envelopes) {
  const groups = new Map();
  for (const e of envelopes) {
    const key = `${e.name || 'unknown'} ${e.ticker || ''}`.trim();
    const g = groups.get(key) || { name: e.name || 'unknown', ticker: e.ticker, n: 0 };
    g.n++; groups.set(key, g);
  }
  return `<span class="op-chips">${[...groups.values()].map((g) => `<span class="op-chip"><code>${escapeHtml(g.name)}</code>${g.ticker ? ` <span class="btc">${escapeHtml(g.ticker)}</span>` : ''}${g.n > 1 ? ` <b>×${number(g.n)}</b>` : ''}</span>`).join('')}</span>`;
}

export function renderBlockList(d) {
  const rows = d.blocks.map((b) => `<tr data-key="${b.height}" data-f="${b.envelopes?.length ? 'tacit' : ''} ${b.state || ''}"><th scope="row"><a href="#/block/${b.height}"><span class="num">${number(b.height)}</span></a></th><td data-s="${b.time || 0}" class="nowrap">${relativeTime(b.time)}</td><td class="nowrap">${number(b.txCount)}</td><td>${b.envelopes == null ? '<span class="muted">decoding…</span>' : b.envelopes.length ? opChips(b.envelopes) : '<span class="muted">none</span>'}</td><td>${b.state ? `<span class="chip ${b.state === 'attested' ? 'eth' : b.state === 'eligible' ? 'btc' : ''}">${STATE[b.state]}</span>` : ''}</td></tr>`).join('');
  const newer = d.from < d.tip ? `#/blocks/${Math.min(d.tip, d.from + 20)}` : null;
  const t = tally(d.blocks, (b) => [b.envelopes?.length ? 'tacit' : '', b.state]);
  const bar = filterBar('blocks', { total: d.blocks.length, groups: [
    { name: 'tacit', label: 'Tacit envelopes', keepSingle: true, options: [['tacit', 'With Tacit envelopes', t.tacit]] },
    { name: 'bridge', label: 'Bridge', all: 'Any bridge state', options: [['confirming', 'Confirming', t.confirming], ['eligible', 'Awaiting reflection', t.eligible], ['attested', 'Attested', t.attested]] },
  ] });
  return pageHead({ crumbs: [['Bitcoin', '#/bitcoin'], ['Blocks']], title: 'Bitcoin blocks', chips: [[`tip ${number(d.tip)}`, 'btc'], [`attested to ${number(d.bridge?.attested)}`, 'eth']] })
    + `<section class="card">${bar}<div class="table-wrap"><table class="table"><thead><tr>${sortTh('Height')}${sortTh('Mined')}${sortTh('Transactions')}<th scope="col">Tacit ${term('envelopes', 'envelope')}</th>${sortTh('Bridge', 'text')}</tr></thead><tbody>${rows}</tbody></table></div>${d.partial ? '<p class="note">Some blocks are still decoding; they fill in by themselves in a few seconds.</p>' : ''}${pagination(pages('blocks', d.tip, d.from))}</section>`;
}

const KIND = POOL_EVENT;
export function renderPoolEvents(d) {
  const rows = d.events.map((e) => `<tr data-key="${escapeHtml(`${e.tx}:${e.logIndex}`)}" data-f="${escapeHtml(e.type)}" data-q="${escapeHtml(`${e.tx} ${e.nullifier || ''} ${e.block}`.toLowerCase())}"><th scope="row">${escapeHtml(KIND[e.type] || e.type)}</th><td>${e.type === 'leaves' ? `leaf #${number(e.leafIndex)}${e.count > 1 ? ` +${e.count - 1}` : ''}` : e.type === 'nullifiers' ? `<code>${escapeHtml(shortId(e.nullifier, 6))}</code>${e.count > 1 ? ` +${e.count - 1}` : ''}` : ''}</td><td class="num">${number(e.block)}</td><td><span class="hash-cell"><a href="#/eth/${escapeHtml(e.tx)}"><code>${escapeHtml(shortId(e.tx, 5))}</code></a>${copyIcon(e.tx, 'transaction hash')}</span></td></tr>`).join('');
  // One explanation per event kind on the page, not one hidden tooltip per row.
  const TERM_KEY = { leaves: 'note created', nullifiers: 'note spent', wrap: 'wraps', crossOut: 'cross-outs' };
  const kinds = [...new Set(d.events.map((e) => e.type))].filter((t) => TERM_KEY[t]);
  const about = kinds.length && ['What these events are', kinds.map((t) => `${KIND[t][0].toUpperCase()}${KIND[t].slice(1)}: ${TERMS[TERM_KEY[t]]}`).join('\n')];
  const newer = d.to < d.head ? `#/pool-events/${Math.min(d.head, d.to + 2000)}` : null;
  const t = tally(d.events, (e) => e.type);
  const bar = filterBar('pool-events', { total: d.events.length, scope: 'in these 2,000 blocks', search: 'Filter by transaction, nullifier or block',
    groups: [{ name: 'kind', label: 'Event', options: Object.keys(KIND).map((k) => [k, KIND[k][0].toUpperCase() + KIND[k].slice(1), t[k]]) }] });
  return pageHead({ crumbs: [['Ethereum', '#/ethereum'], ['ConfidentialPool events']], title: 'ConfidentialPool events', chips: [[`Ethereum blocks ${number(d.from)}–${number(d.to)}`, 'eth']], about })
    + `<section class="card">${bar}<div class="table-wrap"><table class="table"><thead><tr>${sortTh('Event', 'text')}<th scope="col">Detail</th>${sortTh('Ethereum block')}<th scope="col">Transaction</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No pool events in these 2,000 blocks.</td></tr>'}</tbody></table></div>${pagination({ prev: newer, next: d.next != null ? `#/pool-events/${d.next}` : null })}${d.olderOn ? `<p class="note">Older pool events need an archive node, which the free public RPCs this explorer reads do not serve. ${link(d.olderOn, 'See them on Etherscan')}.</p>` : ''}</section>`;
}

export function renderAssetList(d) {
  const rows = d.assets.map((a) => `<tr data-f="${a.verified ? 'verified' : ''}" data-q="${escapeHtml(`${a.ticker || ''} ${a.id}`.toLowerCase())}"><th scope="row"><a class="asset-name" href="#/asset/${escapeHtml(a.id)}">${assetIcon(a.id, a.ticker)}${escapeHtml(assetName(a.ticker, a.id))}</a>${a.verified ? ' <span class="badge ok">Verified</span>' : ''}</th><td><span class="hash-cell"><code>${escapeHtml(shortId(a.id, 6))}</code>${copyIcon(a.id, 'asset id')}</span></td><td class="num-sans">${number(a.holders)}</td><td class="num-sans">${number(a.transfers)}</td><td class="num-sans">${a.etchedHeight ? `<a href="#/block/${a.etchedHeight}">${number(a.etchedHeight)}</a>` : '—'}</td></tr>`).join('');
  return pageHead({ crumbs: [['Bitcoin', '#/bitcoin'], ['Assets']], title: 'Assets', chips: [[`${number(d.assets.length)} on mainnet`, 'btc']], about: ['Tickers are not unique', 'Two assets can share a ticker. The asset id is what identifies one.'] })
    + `<section class="card">${filterBar('assets', { total: d.assets.length, scope: 'on mainnet', search: 'Filter by ticker or asset id', groups: [{ name: 'verified', label: 'Verification', keepSingle: true, options: [['verified', 'Verified', d.assets.filter((a) => a.verified).length]] }] })}<div class="table-wrap"><table class="table"><thead><tr>${sortTh('Ticker', 'text')}<th scope="col">Asset id</th>${sortTh('Holders')}${sortTh('Transfers')}${sortTh('Etched in block')}</tr></thead><tbody>${rows || '<tr><td colspan="5">No assets.</td></tr>'}</tbody></table></div></section>`;
}

// Every traced ConfidentialPool spend (/views/traced): the note's creating transaction and the spending one. Click
// both to see the same note: the spend's nullifier is keccak(leaf ‖ "spent") of a leaf the first one inserted.
export function renderTraced(d) {
  const ethTx = (h) => (h ? `<a href="#/eth/${escapeHtml(h)}"><code>${escapeHtml(shortId(h, 6))}</code></a>` : '<span class="muted">looking up…</span>');
  const rows = d.pairs.map((p) => `<tr><th scope="row">${p.lock ? 'Lock' : 'Bearer note'}</th><td><span class="hash-cell">${ethTx(p.made)}</span> <span class="muted">· block ${number(p.madeBlock)}</span></td><td><span class="hash-cell">${ethTx(p.spent)}</span> <span class="muted">· block ${number(p.spentBlock)}</span></td><td class="nowrap">${number(p.spentBlock - p.madeBlock)} blocks</td></tr>`).join('');
  return pageHead({ crumbs: [['Privacy', '#/privacy'], ['Traced spends']], title: 'Traced spends', chips: [[`${number(d.total)} traced`, 'eth']], about: ['What a traced spend is', 'A bearer note or a lock is spent with a nullifier made from its leaf alone, so anyone can match the spend to the transaction that created the note. Owned notes use a secret key and never appear here.'] })
    + `<section class="card"><div class="table-wrap"><table class="table"><thead><tr><th scope="col">Kind</th><th scope="col">Created in</th><th scope="col">Spent in</th><th scope="col">Apart</th></tr></thead><tbody>${rows || '<tr><td colspan="4">None yet.</td></tr>'}</tbody></table></div></section>`;
}
