// Shared pieces for detail pages: page header, key/value table, privacy panel, bridge strip.
import { escapeHtml, number, info, sentence } from '../format.js';

export const copyButton = (value, label = 'Copy') => `<button type="button" class="copy" data-copy="${escapeHtml(value)}">${label}</button>`;
// The small icon version for table rows: copies the full value behind a shortened one.
const COPY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 3.5v-.4A1.6 1.6 0 0 0 8.9 1.5H4.1A1.6 1.6 0 0 0 2.5 3.1v4.8a1.6 1.6 0 0 0 1.6 1.6h.4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
export const copyIcon = (value, what = 'value') => `<button type="button" class="copy-ico" data-copy="${escapeHtml(value)}" aria-label="Copy ${escapeHtml(what)}" title="Copy ${escapeHtml(what)}">${COPY_ICON}</button>`;

// idShort: show a shortened id (the full id stays in the tooltip and is what Copy copies); idAfter: html right after it.
// `chipsAfter`: HTML placed after the chips (the withdrawal-check pill on EVM pages).
export function pageHead({ crumbs, title, id, chips = [], links = [], icon = '', idShort = 0, idAfter = '', about = '', chipsAfter = '' }) {
  const trail = crumbs.map(([text, href]) => (href ? `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>` : `<span>${escapeHtml(text)}</span>`)).join(' / ');
  return `<header class="page-head"><nav aria-label="Breadcrumb" class="crumbs">${trail}</nav>
    <div class="page-title">${icon}<h1>${escapeHtml(title)}</h1>${about ? info(about) : ''}${id ? `<code class="hash${idShort ? ' short' : ''}" title="${escapeHtml(id)}">${escapeHtml(idShort && id.length > idShort * 2 + 1 ? `${id.slice(0, idShort)}…${id.slice(-idShort)}` : id)}</code>${idAfter}${copyButton(id)}` : ''}${links.filter(Boolean).length ? `<span class="site-links">${links.filter(Boolean).join('')}</span>` : ''}</div>
    ${chips.length || chipsAfter ? `<div class="chips">${chips.map(([text, tone]) => `<span class="chip ${tone || ''}">${escapeHtml(text)}</span>`).join('')}${chipsAfter}</div>` : ''}</header>`;
}

// rows: [label, html, { mono }]
export const kvTable = (rows) => `<section class="card kvtable">${rows.filter(Boolean).map(([k, v, o = {}]) => `<div class="kvrow"><span>${escapeHtml(k)}</span><span class="${o.mono ? 'num' : ''}">${v}</span></div>`).join('')}</section>`;

// Tacit's own mark (its favicon at tacit.finance: a ring and a "t"), drawn in one grey as a watermark that bleeds off
// the Privacy card's top-right corner. Decoration only.
const TACIT_MARK = '<svg class="pmark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M17.5 7L13 22.5Q13 25 18 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 11L21 11" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
export function privacyPanel(visible, hidden, warning) {
  return `<section class="card has-mark">${TACIT_MARK}<header class="card-head"><h2>Privacy</h2></header>
    <h3 class="ok sub-tight">Visible</h3>${visible.map(([k, v]) => `<div class="kv"><span>${escapeHtml(sentence(k))}</span><span class="num">${escapeHtml(sentence(v))}</span></div>`).join('')}
    <h3 class="muted sub-tight sub-gap">Hidden</h3>${hidden.map((h) => `<div class="kv hidden-kv"><span class="redact" aria-hidden="true"></span><span>${escapeHtml(sentence(h))}</span></div>`).join('')}
    ${warning ? `<p class="callout">${escapeHtml(warning)}</p>` : ''}</section>`;
}

const STATE_TEXT = { attested: 'Attested', eligible: 'Awaiting reflection', confirming: 'Confirming' };

// 24 confirmation cells, then attestation, then the pool.
// `settled` = cells already shown before a live refresh; only cells after it animate in.
export function bridgeStrip({ confirmations, bridge, height }, settled = 0) {
  const need = bridge.confirmationsNeeded;
  const filled = Math.min(need, Math.max(0, confirmations || 0));
  const attested = bridge.state === 'attested';
  const step = Math.min(24, 200 / Math.max(1, filled - settled)); // the whole fill stays under ~0.5s however many cells
  const cells = Array.from({ length: need }, (_, i) => (i < filled ? `<i class="conf on${i < settled ? ' static' : ''}" style="--d:${Math.round(Math.max(0, i - settled) * step)}ms"></i>` : '<i class="conf"></i>')).join('');
  const upTo = `Current bridge attestation: block ${number(bridge.attested)}.`;
  const line = !bridge.state ? 'Bridge state unavailable right now.'
    : attested ? `Attested to Ethereum. ${upTo}`
      : filled < need ? `${number(need - filled)} more block${need - filled === 1 ? '' : 's'} until reflection. ${upTo}`
        : bridge.state === 'eligible' ? `Ready for the next reflection. ${upTo}`
          : `${number(need)} Bitcoin confirmations reached; waiting for the relay on Ethereum to see this block ${number(need)} deep${bridge.relayTip ? ` (relay at ${number(bridge.relayTip)})` : ''}. ${upTo}`;
  return `<section class="card" id="bridge-strip" data-filled="${filled}" data-state="${escapeHtml(bridge.state || '')}"><header class="card-head"><h2>Bridge to Ethereum</h2><span class="status">${bridge.state ? `${escapeHtml(STATE_TEXT[bridge.state])} · ` : ''}${number(filled)} / ${number(need)}</span></header>
    <div class="strip">${cells}<span class="stage ${attested ? 'done' : bridge.state === 'eligible' ? 'next' : ''}">Reflection</span><span class="stage eth ${attested ? 'done' : ''}">In ConfidentialPool</span></div>
    <p class="note">${escapeHtml(line)}</p></section>`;
}

const ARROW = (d) => `<svg class="pager-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// Previous / next links with arrows; an empty slot keeps "next" on the right when there is no "previous".
export const pagerNav = (prev, next, prevText = 'Previous block', nextText = 'Next block') => `<nav class="pager">${prev ? `<a href="${prev}" data-nav="prev" title="${prevText} (←)">${ARROW('M10 3.5 5.5 8l4.5 4.5')}${prevText}</a>` : '<span></span>'}${next ? `<a href="${next}" data-nav="next" title="${nextText} (→)">${nextText}${ARROW('M6 3.5 10.5 8 6 12.5')}</a>` : ''}</nav>`;

// Page navigation for the list pages: Previous, numbered pages with gaps, Next. Pages count from the newest (page 1).
// Without a page count (a list whose depth is not known) it shows Previous and Next only. ← and → still work
// (data-nav). href(k) gives page k's link.
export function pagination({ page, pages, href, prev, next, prevText = 'Newer', nextText = 'Older' }) {
  const prevHref = prev ?? (page > 1 ? href(page - 1) : null), nextHref = next ?? (pages && page < pages ? href(page + 1) : null);
  // Arrows only, sitting right beside the numbers; the words stay for screen readers and the tooltip.
  const edge = (h, text, dir, path) => (h
    ? `<a class="pg-edge" href="${h}" data-nav="${dir}" title="${text} (${dir === 'prev' ? '←' : '→'})" aria-label="${text}">${ARROW(path)}</a>`
    : `<span class="pg-edge is-off" aria-hidden="true">${ARROW(path)}</span>`);
  let nums = '';
  if (pages && page) {
    const want = new Set([1, pages, page - 1, page, page + 1].filter((k) => k >= 1 && k <= pages));
    if (page <= 3) [2, 3, 4].forEach((k) => k <= pages && want.add(k));
    if (page >= pages - 2) [pages - 3, pages - 2, pages - 1].forEach((k) => k >= 1 && want.add(k));
    let lastK = 0;
    for (const k of [...want].sort((a, b) => a - b)) {
      if (k - lastK > 1) nums += '<span class="pg-gap" aria-hidden="true">…</span>';
      nums += k === page ? `<span class="pg-num is-on" aria-current="page">${number(k)}</span>` : `<a class="pg-num" href="${href(k)}">${number(k)}</a>`;
      lastK = k;
    }
  }
  return `<nav class="pagination" aria-label="Pages">${edge(prevHref, prevText, 'prev', 'M10 3.5 5.5 8l4.5 4.5')}${nums ? `<span class="pg-nums">${nums}</span>` : ''}${edge(nextHref, nextText, 'next', 'M6 3.5 10.5 8 6 12.5')}</nav>`;
}

export const notFound = (message) => `<header class="page-head"><h1>Not found</h1></header><section class="card"><p class="empty">${escapeHtml(message)}</p><p><a href="#/">Back to overview</a></p></section>`;
