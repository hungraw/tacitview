// EVM address page, from the footprint view: balances on each chain, Tacit EVM pool deposits, names, known contract.
import { escapeHtml, formatUnits, shortId, number, relativeTime, siteLink, chainBadge } from '../format.js';
import { pageHead, copyIcon } from './common.js';
import { filterBar } from '../filters.js';
import { exposureSlot } from '../exposure.js';

const CHAIN_ORDER = ['Ethereum', 'Base', 'Robinhood'];
const CHAIN_KEY = { Ethereum: 'eth', Base: 'base', Robinhood: 'rh' };
const chainMark = (name) => chainBadge(CHAIN_KEY[name] || 'eth');
const SHORT = { Robinhood: 'RH' }; // the deposit chart's key only
// Name systems in display order: XNS (name@space), ENS (.eth), Wei (.wei), Gwei (.gwei), Basenames (.base.eth).
const NAME_ORDER = ['XNS', 'ENS', 'Wei Name Service', 'Gwei Name Service', 'Basenames'];
const compact = (n) => (n == null ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n)));
const eth = (wei, digits = 4) => (wei == null ? '—' : `${formatUnits(wei, 18, digits)} ETH`);

function balancesCard(rows) {
  const list = CHAIN_ORDER.map((c) => rows.find((r) => r[0] === c)).filter(Boolean);
  const max = Math.max(...list.map((r) => Number(r[1] || 0)), 1);
  return `<section class="card"><header class="card-head"><h2>Balances</h2></header>`
    + list.map(([chain, wei]) => `<div class="op-bar chain-bar">${chainMark(chain)}<span>${escapeHtml(chain)}</span><i class="is-${CHAIN_KEY[chain]}" style="--w:${wei && wei !== '0' ? Math.max(3, Math.round((Number(wei) / max) * 100)) : 0}%"></i><span class="num">${eth(wei)}</span></div>`).join('')
    + `<p class="mini-label">Transactions sent</p><p class="sent-line">${list.map(([chain, , n]) => `<span><span class="num">${n == null ? '—' : number(n)}</span> ${escapeHtml(chain)}</span>`).join('<span class="muted"> · </span>')}</p></section>`;
}

function timeline(list) {
  const pts = list.filter((e) => e.time).slice().reverse(); // oldest first
  if (pts.length < 2) return '';
  const W = 400, H = 64;
  const max = Math.max(...pts.map((e) => Number(e.wei || 0)), 1);
  const w = (W - 4) / pts.length;
  // Each bar links to its deposit transaction.
  const bars = pts.map((e, i) => { const h = Math.max(4, (Number(e.wei || 0) / max) * (H - 4)); const bar = `<rect x="${(2 + i * w).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(1, w - 1).toFixed(1)}" height="${h.toFixed(1)}" rx="1" class="is-${CHAIN_KEY[e.chain] || 'eth'}"><title>${escapeHtml(`${SHORT[e.chain] || e.chain} · ${eth(e.wei)} · ${e.detail}`)}</title></rect>`; return e.id ? `<a href="#/eth/${escapeHtml(e.id)}">${bar}</a>` : bar; }).join('');
  const per = CHAIN_ORDER.map((c) => [c, pts.filter((e) => e.chain === c).length]).filter(([, n]) => n);
  // Left: when the first bar's deposit was made. The last bar is the newest deposit, so it needs no label.
  const firstAt = new Date(pts[0].time * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<svg class="dep-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Last ${pts.length} deposits by size and chain">${bars}</svg>`
    + `<div class="bal-axis"><span>${escapeHtml(firstAt)}</span><span class="bal-key">${per.map(([c, n]) => `<i class="is-${CHAIN_KEY[c]}"></i>${number(n)} on ${escapeHtml(SHORT[c] || c)}`).join(' ')}</span></div>`;
}

export function renderAddress(d) {
  const item = (t) => (d.items || []).find((i) => i.title.startsWith(t));
  const typed = item('Name')?.rows || []; // the name that was searched, if any
  const typedName = typed.find((r) => r[0] === 'Name');
  const names = [...(typedName ? [[typed.find((r) => r[0] === 'Service')?.[1], typedName[1], typedName[2]]] : []), ...(item('Names')?.rows || [])];
  const address = (d.items || []).flatMap((i) => i.rows || []).find((r) => /^0x[0-9a-f]{40}$/i.test(String(r[1])))?.[1] || (/^0x[0-9a-f]{40}$/i.test(d.query) ? d.query : null);
  const known = item('Known Tacit contract')?.rows.find((r) => r[0] === 'Contract')?.[1] || null;
  const deposits = item('EVM pool deposits');
  const stat = (k) => deposits?.rows.find((r) => r[0] === k);
  const list = deposits?.list || [];
  const chips = known ? [[known, '']] : [];
  // Names sit next to the address they name, each linking to its service's profile.
  const rank = (service) => { const i = NAME_ORDER.indexOf(service); return i < 0 ? NAME_ORDER.length : i; };
  const ordered = [...new Map(names.map((x) => [x[1], x])).values()].sort((a, b) => rank(a[0]) - rank(b[0]));
  const one = ([service, n, url]) => (url ? `<a class="name-pill" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" title="${escapeHtml(service || '')}">${escapeHtml(n)}</a>` : `<span class="name-pill" title="${escapeHtml(service || '')}">${escapeHtml(n)}</span>`);
  // Several names: the first by NAME_ORDER as a pill that opens the rest (the names popover in names.js).
  const namePills = ordered.length < 2 ? ordered.map(one) : [`<button type="button" class="name-pill has-more" aria-expanded="false" data-names="${escapeHtml(JSON.stringify(ordered.map(([service, n, url]) => ({ name: n, service: service || '', url: url || null }))))}">${escapeHtml(ordered[0][1])}<span class="more-count">+${ordered.length - 1}</span></button>`];
  // Withdrawal check verdict for this address, top right of the pool card; it links to the full check.
  const check = address ? `<span class="card-head-end">${exposureSlot(address)}</span>` : '';
  const pool = deposits
    ? `<section class="card"><header class="card-head"><h2>Tacit EVM pool</h2>${check}</header><div class="stat-row">`
      + `<div class="stat"><span class="mini-label" title="As Tacit's points service (/points) counts them; the withdrawal check counts the ETH pool's own logs, so the two can differ">Deposits · Tacit points</span><b class="num">${number(stat('Deposits')?.[1])}</b></div>`
      + `<div class="stat"><span class="mini-label">Total deposited</span><b class="num">${eth(stat('Total deposited')?.[3]?.wei, 0)}</b></div>`
      + `<div class="stat"><span class="mini-label">Points</span><b class="num">${compact(stat('Points')?.[1])}</b></div></div>${timeline(list)}</section>`
    : `<section class="card"><header class="card-head"><h2>Tacit EVM pool</h2>${check}</header><p class="empty">No deposits.</p></section>`;
  const shownDeposits = list.slice(0, 25);
  const rows = shownDeposits.map((e) => `<div class="tx-row" data-f="${CHAIN_KEY[e.chain] || 'eth'}">${chainMark(e.chain)}<span class="tx-main"><span class="hash-cell"><a href="#/eth/${escapeHtml(e.id)}"><code>${escapeHtml(shortId(e.id, 4))}</code></a>${copyIcon(e.id, 'transaction hash')}</span> <span class="pill-soft">${escapeHtml(e.activity === 'evmpooldeposit' ? 'Pool deposit' : String(e.activity || '').charAt(0).toUpperCase() + String(e.activity || '').slice(1))}</span></span><span class="tx-when">${e.time ? relativeTime(e.time) : escapeHtml(e.detail || '')}</span><span class="tx-delta num">${eth(e.wei)}${e.points != null ? ` · +${number(Math.round(e.points))} pts` : ''}</span></div>`).join('');
  return [
    pageHead({ crumbs: [['Ethereum', '#/ethereum'], ['EVM address']], title: 'EVM address', id: address || d.query, icon: chainBadge('eth', 'lg'), chips, links: [...namePills, address && siteLink(`https://etherscan.io/address/${address}`, 'Etherscan')] }),
    `<div class="grid addr-grid addr-grid-eth">${item('Balances') ? balancesCard(item('Balances').rows) : ''}${pool}</div>`,
    rows ? `<section class="card"><header class="card-head"><h2>Recent deposits</h2><span class="card-head-end">${stat('Points')?.[1] != null ? `<span class="status" title="All points Tacit's points service (/points) gives this address">Total ${number(Math.round(Number(stat('Points')[1])))} pts</span>` : ''}</span></header>${filterBar('evm-deposits', { total: shownDeposits.length, scope: 'shown', remember: false, groups: [{ name: 'chain', label: 'Chain', all: 'All chains', options: CHAIN_ORDER.map((c) => [CHAIN_KEY[c], c, shownDeposits.filter((e) => e.chain === c).length]) }] })}${rows}</section>` : '',
    (d.notes || []).filter((n) => !/^No EVM pool deposits/.test(n)).length ? `<section class="card">${d.notes.filter((n) => !/^No EVM pool deposits/.test(n)).map((n) => `<p class="empty">${escapeHtml(n)}</p>`).join('')}</section>` : '',
  ].join('');
}
