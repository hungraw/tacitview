// API figures checked against independent chain endpoints (/views/checks). Each row can reveal the commands that
// fetch both of its numbers, so a visitor can check them without trusting this site.
import { escapeHtml, number, formatUnits, shortId, pill } from '../format.js';

const fmt = (row, v) => (v == null ? '—' : row.unit === 'wei' ? `${formatUnits(v, 18, 6)} ETH` : row.unit === 'hash' || typeof v === 'string' && /^(0x)?[0-9a-f]{64}$/i.test(v) ? escapeHtml(shortId(v, 6)) : typeof v === 'string' && !/^\d+$/.test(v) ? escapeHtml(v) : number(v));

// One summary for both check cards: a figure that was not compared (not reported, or a cached answer) is neither a
// match nor a fault, and is counted on its own.
const UNCOMPARED = new Set(['stale', 'not reported']);
export function checkCounts(rows = []) {
  const ok = rows.filter((r) => !r.error && (r.status === 'match' || r.status === 'paced')).length;
  const open = rows.filter((r) => !r.error && UNCOMPARED.has(r.status)).length;
  return { ok, open, bad: rows.length - ok - open };
}
export function checkSummary(rows = []) {
  const { ok, open, bad } = checkCounts(rows);
  return `<span class="pills">${pill(`${ok} match`, 'ok')}${open ? pill(`${open} not compared`, 'muted') : ''}${bad ? pill(`${bad} to check`, 'warn') : ''}</span>`;
}

// The result of one row as a pill: what happened, then by how much.
export function resultPill(row) {
  if (row.error) return pill('Unavailable', 'bad', row.error);
  const by = row.diff ? ` · ${row.unit === 'wei' ? `${formatUnits(String(row.diff).replace('-', ''), 18, 6)} ETH` : `${number(Math.abs(row.diff))} ${row.unit}`}` : '';
  if (row.status === 'match') return pill('Match', 'ok');
  if (row.status === 'paced') return `<span class="pills">${pill('Match', 'ok')}${pill(`Paced${by}`, 'info')}</span>`; // an expected, paced gap still passes
  if (row.status === 'stale') return pill('Not compared', 'muted');
  if (row.status === 'not reported') return pill('Not reported', 'muted');
  if (row.status === 'behind') return pill(`Behind${by}`, 'warn');
  return pill(`Differs${by}`, 'bad');
}

const TERMINAL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 5 3 3-3 3M8.5 11.5h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const COPY = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
const open = new Set(); // rows whose commands are showing, kept across refreshes
// The exchange mark between the two sides each group compares.
export const SWAP = '<svg class="swap" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5h10m-2.5-2.5 2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// Tacit's API against the chain first (the point of the card), then the bridge on Ethereum against Bitcoin.
export const GROUPS = [
  { key: 'api', sides: ["Tacit's API", 'On-chain'], cols: ["Tacit's API", 'On-chain'] }, // on-chain: read from the contracts, logs and raw blocks
  { key: 'bridge', sides: ['Ethereum', 'Bitcoin'], cols: ['On Ethereum', 'On Bitcoin'] },
];
export const groupTitle = (g) => `${escapeHtml(g.sides[0])} ${SWAP}<span class="sr-only"> compared with </span> ${escapeHtml(g.sides[1])}`;

export default {
  id: 'checks',
  sources: ['checks'],
  render({ checks: d }) {
    const all = (d.rows || []).map((row, i) => ({ row, i }));
    const tables = GROUPS.map((g) => {
      const rows = all.filter(({ row }) => (row.group || 'api') === g.key).map(({ row, i }) => {
        const key = `r${i}`, shown = open.has(row.figure);
        const toggle = row.repro?.length ? `<button type="button" class="pill is-muted repro-toggle" data-figure="${escapeHtml(row.figure)}" aria-expanded="${shown}" aria-controls="repro-${key}" title="Commands that fetch both numbers">${TERMINAL}Check</button>` : '';
        const cmds = row.repro?.length ? `<tr class="repro" id="repro-${key}"${shown ? '' : ' hidden'}><td colspan="5">${row.repro.map((c) => `<div class="repro-cmd"><code>${escapeHtml(c)}</code><button type="button" class="repro-copy" aria-label="Copy command">${COPY}</button></div>`).join('')}</td></tr>` : '';
        return `<tr><th scope="row">${escapeHtml(row.label || row.figure)}${row.sub ? `<small>${escapeHtml(row.sub)}</small>` : ''}</th><td><span class="num">${fmt(row, row.api)}</span><small>${escapeHtml(row.apiSource)}</small></td><td><span class="num">${fmt(row, row.chain)}</span><small>${escapeHtml(row.chainSource)}</small></td><td>${resultPill(row)}</td><td class="check-cell">${toggle}</td></tr>${cmds}`;
      }).join('');
      if (!rows) return '';
      return `<h3 class="check-group">${groupTitle(g)}</h3><div class="table-wrap"><table class="table checks-table"><colgroup><col class="c-fig"><col class="c-val"><col class="c-val"><col class="c-res"><col class="c-chk"></colgroup><thead><tr><th scope="col">Figure</th><th scope="col">${escapeHtml(g.cols[0])}</th><th scope="col">${escapeHtml(g.cols[1])}</th><th scope="col">Result</th><th scope="col"><span class="sr-only">Check it yourself</span></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }).join('');
    return {
      html: tables,
      status: checkSummary(d.rows),
      asOf: '',
      source: 'public RPCs · mempool.space',
    };
  },
};

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('click', async (event) => {
    const toggle = event.target.closest('.repro-toggle');
    if (toggle) {
      const row = document.getElementById(toggle.getAttribute('aria-controls'));
      const show = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(show));
      if (row) row.hidden = !show;
      if (show) open.add(toggle.dataset.figure); else open.delete(toggle.dataset.figure);
      return;
    }
    const copy = event.target.closest('.repro-copy');
    if (copy) {
      try { await navigator.clipboard.writeText(copy.previousElementSibling.textContent); copy.classList.add('is-done'); } catch { /* clipboard blocked: nothing to undo */ }
      setTimeout(() => copy.classList.remove('is-done'), 1200);
    }
  });
}
