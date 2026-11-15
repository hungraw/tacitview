// The chain checks in one line each, for the home page. The full table lives on the Bridge page.
import { escapeHtml, clock } from '../format.js';
import { checkSummary, GROUPS, groupTitle } from './checks.js';

export default {
  id: 'checks-mini',
  sources: ['checks'],
  render({ checks: d }) {
    const rows = d.rows || [];
    const chip = (r) => {
      const tone = r.error ? 'bad' : r.status === 'match' ? 'ok' : r.status === 'paced' ? 'info' : r.status === 'stale' || r.status === 'not reported' ? 'muted' : 'warn';
      const mark = tone === 'ok' || tone === 'info' ? '✓' : tone === 'muted' ? '–' : '!'; // an expected gap (paced relay) passes; an uncompared figure is neither
      const name = r.label || r.figure;
      const detail = r.error ? 'source unavailable' : r.status === 'match' ? 'matches' : `${r.status}${r.diff ? ` · ${r.unit === 'wei' ? 'balance' : `${r.diff} ${r.unit}`}` : ''}`;
      const tip = `${detail}${r.note ? ` · ${r.note}` : ''}`;
      return `<li class="chip-check is-${tone}" title="${escapeHtml(tip)}"><span aria-hidden="true">${mark}</span>${escapeHtml(name)}<span class="sr-only">: ${escapeHtml(detail)}</span></li>`;
    };
    // One line per group, its two sides first: Tacit's API against the chain, then the bridge against Bitcoin.
    const lines = GROUPS.map((g) => {
      const mine = rows.filter((r) => (r.group || 'api') === g.key);
      return mine.length ? `<div class="checks-line"><span class="checks-side">${groupTitle(g)}</span><ul class="checks-strip">${mine.map(chip).join('')}</ul></div>` : '';
    }).join('');
    return {
      html: lines,
      status: checkSummary(rows),
      asOf: '',
      source: 'public RPCs · Esplora',
    };
  },
};
