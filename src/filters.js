// Filter bars for list pages: chips per group (AND across groups), an optional text filter, and a live count.
// Rows opt in with data-f="token token…" (what the chips match) and data-q="…" (what the text filter searches).
// Filtering is client-side over the rows on the page, and the count says so. The last choice per list is remembered
// (localStorage) so paging keeps it; lists that belong to one block or address (remember: false) start fresh.
import { escapeHtml, number } from './format.js';

const KEY = 'tacit-explorer:filter:';
const read = (id) => { try { return JSON.parse(localStorage.getItem(KEY + id)) || {}; } catch { return {}; } };
const write = (id, v) => { try { localStorage.setItem(KEY + id, JSON.stringify(v)); } catch { /* optional */ } };

const SEARCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// groups: [{ name, label, options: [[token, text, count]] }]. A group with fewer than two non-empty options is left out.
// search: placeholder text, or '' for none. scope: what the count covers ('on this page', 'loaded').
export function filterBar(id, { groups = [], search = '', total = 0, scope = 'on this page', remember = true } = {}) {
  const shown = groups.map((g) => ({ ...g, options: g.options.filter(([, , n]) => n > 0) })).filter((g) => g.options.length > 1 || (g.keepSingle && g.options.length));
  if (!shown.length && !search) return '';
  const chips = shown.map((g) => `<div class="fchips" role="group" aria-label="${escapeHtml(g.label)}" data-group="${escapeHtml(g.name)}">`
    + `<button type="button" class="fchip" data-v="" aria-pressed="true">${escapeHtml(g.all || 'All')}</button>`
    + g.options.map(([v, text, n]) => `<button type="button" class="fchip" data-v="${escapeHtml(v)}" aria-pressed="false">${escapeHtml(text)}<b>${number(n)}</b></button>`).join('')
    + '</div>').join('');
  const box = search ? `<label class="fsearch">${SEARCH}<span class="sr-only">${escapeHtml(search)}</span><input type="search" placeholder="${escapeHtml(search)}" spellcheck="false" autocomplete="off"></label>` : '';
  return `<div class="filter-bar" data-filter="${escapeHtml(id)}"${remember ? '' : ' data-forget'} data-total="${total}" data-scope="${escapeHtml(scope)}">${chips}${box}<span class="fcount" aria-live="polite"></span></div>`;
}

function apply(bar) {
  const card = bar.closest('.card') || bar.parentElement;
  const picks = [...bar.querySelectorAll('.fchips')].map((g) => g.querySelector('.fchip[aria-pressed="true"]')?.dataset.v).filter(Boolean);
  const q = (bar.querySelector('.fsearch input')?.value || '').trim().toLowerCase();
  const rows = [...card.querySelectorAll('[data-f]')];
  let n = 0;
  for (const r of rows) {
    const tokens = r.dataset.f.split(' ');
    const ok = picks.every((p) => tokens.includes(p)) && (!q || (r.dataset.q || r.textContent).toLowerCase().includes(q));
    r.hidden = !ok;
    if (ok) n++;
  }
  const filtered = picks.length || q;
  bar.classList.toggle('is-filtering', Boolean(filtered));
  bar.querySelector('.fcount').innerHTML = filtered ? `<b>${number(n)}</b> of ${number(rows.length)} ${escapeHtml(bar.dataset.scope)} <button type="button" class="fclear">Clear</button>` : `${number(rows.length)} ${escapeHtml(bar.dataset.scope)}`;
  let empty = card.querySelector('.filter-empty');
  if (!n && rows.length) {
    if (!empty) { empty = document.createElement('p'); empty.className = 'empty filter-empty'; (card.querySelector('.table-wrap, .rows-list') || bar).after(empty); }
    empty.textContent = `Nothing ${bar.dataset.scope} matches this filter.`;
  } else empty?.remove();
  if (!('forget' in bar.dataset)) write(bar.dataset.filter, { picks: Object.fromEntries([...bar.querySelectorAll('.fchips')].map((g) => [g.dataset.group, g.querySelector('.fchip[aria-pressed="true"]')?.dataset.v || ''])), q });
}

// After a page renders: restore each bar's last choice (if that option still exists) and apply it.
export function initFilters(root) {
  for (const bar of root.querySelectorAll('.filter-bar')) {
    const saved = 'forget' in bar.dataset ? {} : read(bar.dataset.filter);
    for (const g of bar.querySelectorAll('.fchips')) {
      const want = saved.picks?.[g.dataset.group];
      const btn = want && g.querySelector(`.fchip[data-v="${CSS.escape(want)}"]`);
      if (btn) for (const b of g.querySelectorAll('.fchip')) b.setAttribute('aria-pressed', String(b === btn));
    }
    const input = bar.querySelector('.fsearch input');
    if (input && saved.q) input.value = saved.q;
    apply(bar);
  }
}

// Sortable columns: a header made by sortTh() sorts its table's rows by that column, by the cell's data-s value when it
// has one (times, counts behind text) or else its text. Numbers start high-to-low, text A to Z; a second click reverses.
export const sortTh = (label, type = 'num') => `<th scope="col" data-sort="${type}" aria-sort="none"><button type="button" class="th-sort">${label}<i aria-hidden="true"></i></button></th>`;

function sortBy(th) {
  const table = th.closest('table'), body = table.tBodies[0], col = th.cellIndex, num = th.dataset.sort === 'num';
  const now = th.getAttribute('aria-sort');
  const dir = now === 'none' ? (num ? 'descending' : 'ascending') : now === 'descending' ? 'ascending' : 'descending';
  for (const h of table.querySelectorAll('th[data-sort]')) h.setAttribute('aria-sort', h === th ? dir : 'none');
  const key = (row) => { const c = row.cells[col]; const v = c?.dataset.s ?? c?.textContent ?? ''; return num ? Number(String(v).replace(/[^0-9.-]/g, '')) || 0 : String(v).trim().toLowerCase(); };
  const rows = [...body.rows].filter((r) => r.cells.length > 1);
  rows.sort((a, b) => { const x = key(a), y = key(b); const c = num ? x - y : x.localeCompare(y); return dir === 'ascending' ? c : -c; });
  body.append(...rows);
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('click', (event) => {
    const sort = event.target.closest('.th-sort');
    if (sort) { sortBy(sort.closest('th')); return; }
    const chip = event.target.closest('.fchip');
    if (chip) {
      for (const b of chip.parentElement.querySelectorAll('.fchip')) b.setAttribute('aria-pressed', String(b === chip));
      apply(chip.closest('.filter-bar'));
      return;
    }
    const clear = event.target.closest('.fclear');
    if (clear) {
      const bar = clear.closest('.filter-bar');
      for (const g of bar.querySelectorAll('.fchips')) for (const b of g.querySelectorAll('.fchip')) b.setAttribute('aria-pressed', String(!b.dataset.v));
      const input = bar.querySelector('.fsearch input');
      if (input) input.value = '';
      apply(bar);
    }
  });
  document.addEventListener('input', (event) => { const bar = event.target.closest?.('.filter-bar'); if (bar) apply(bar); });
}
