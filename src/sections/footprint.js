// Renders a /views/footprint result. Pure: returns HTML.
import { escapeHtml, formatUnits, link, shortId } from '../format.js';

const KIND_LABELS = {
  'btc-txid-or-asset': 'Bitcoin txid or asset id', 'eth-tx': 'EVM transaction', 'evm-address': 'EVM address',
  'tacit-address': 'tacit address', name: 'name', 'name-or-ticker': 'name or ticker', unknown: 'unrecognised', empty: 'empty',
};

function value(row) {
  const [, raw, href, extra] = row;
  if (raw == null || raw === '') return '—';
  const text = extra?.wei ? `${formatUnits(extra.wei, 18, 4)} ETH` : String(raw);
  const addr = /^0x[0-9a-f]{40}$/i.test(String(raw)) ? ` data-addr="${escapeHtml(raw)}"` : '';
  return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer"${addr}>${escapeHtml(text.length > 70 ? shortId(text, 12) : text)}</a>` : `<span${addr}>${escapeHtml(text)}</span>`;
}

export function renderFootprint(result) {
  const items = (result.items || []).map((item) => `<article class="op"><header><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.source)}</small></header>${
    (item.rows || []).map((row) => `<div class="kv"><span>${escapeHtml(row[0])}</span><span>${value(row)}</span></div>`).join('')}${
    item.list?.length ? `<div class="rows">${item.list.map((e) => `<div class="row"><span class="row-main"><strong>${escapeHtml(e.label)}</strong><span>${escapeHtml(e.detail || '')}</span></span><span class="row-end">${e.wei ? `<b class="num">${formatUnits(e.wei, 18, 4)} ETH</b> ` : ''}${e.href ? link(e.href, shortId(e.id, 5)) : escapeHtml(shortId(e.id, 5))}</span></div>`).join('')}</div>` : ''}</article>`).join('');
  const notes = (result.notes || []).map((n) => `<p class="empty">${escapeHtml(n)}</p>`).join('');
  return `<p class="lookup-q"><span class="badge">${escapeHtml(KIND_LABELS[result.kind] || result.kind)}</span> <code>${escapeHtml(result.query)}</code></p><div class="ops">${items}</div>${notes}<p class="card-foot"><span>${escapeHtml((result.sources || []).join(' · '))}</span></p>`;
}
