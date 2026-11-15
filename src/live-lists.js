// Newest-first list pages (Tacit chain, Bitcoin blocks, pool events) keep checking for new rows while open. New rows
// are not pushed into the table under the reader; a pill says how many arrived, and a click shows them, marked.
import { detail } from './data/api.js';
import { refreshPaused } from './settings.js';
import { number } from './format.js';

const LISTS = {
  'chain-list': { rows: (d) => d.blocks, key: (b) => String(b.height), noun: ['block', 'blocks'] },
  'block-list': { rows: (d) => d.blocks, key: (b) => String(b.height), noun: ['block', 'blocks'] },
  'pool-events': { rows: (d) => d.events, key: (e) => `${e.tx}:${e.logIndex}`, noun: ['event', 'events'] },
};
const EVERY_MS = 20_000;
let timer = 0;
const tableCard = () => document.querySelector('#page .table-wrap')?.closest('.card');
const baseTitle = () => document.title.replace(/^\(\d+\) /, '');

// route: the parsed list route; data: what the page was drawn from; draw(data): redraws the page (returns nothing).
export function watchList(route, data, draw) {
  clearTimeout(timer);
  watching = null;
  const list = LISTS[route.view];
  if (!list || route.id) return; // only the newest page grows
  const hash = location.hash;
  let shown = new Set(list.rows(data).map(list.key));
  let latest = null;

  const pill = () => document.querySelector('#page .new-pill');
  const show = (n) => {
    let p = pill();
    if (!n) { p?.remove(); document.title = baseTitle(); return; }
    if (!p) {
      p = document.createElement('button');
      p.type = 'button';
      p.className = 'new-pill';
      document.getElementById('page')?.prepend(p); // a toast at the top of the page, above any chart
    }
    p.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>${number(n)} new ${list.noun[n === 1 ? 0 : 1]}`;
    p.setAttribute('aria-label', `Show ${n} new ${list.noun[n === 1 ? 0 : 1]}`);
    document.title = `(${n}) ${baseTitle()}`;
  };

  const tick = async () => {
    if (location.hash !== hash) return;
    if (!document.hidden && !refreshPaused()) {
      try {
        const d = await detail(route.view, route.id);
        if (location.hash !== hash) return;
        latest = d;
        show(list.rows(d).filter((r) => !shown.has(list.key(r))).length);
      } catch { /* try again next time */ }
    }
    timer = setTimeout(tick, EVERY_MS);
  };
  timer = setTimeout(tick, EVERY_MS);

  watching = { list, draw, get shown() { return shown; }, set shown(v) { shown = v; }, get latest() { return latest; }, set latest(v) { latest = v; } };
}

// One listener for every watched page: the pill redraws the page with the newer rows, marked, and scrolls to them.
let watching = null;
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('click', (event) => {
  if (!event.target.closest('#page .new-pill') || !watching?.latest) return;
  const { list, draw, latest, shown } = watching;
  const fresh = new Set(list.rows(latest).map(list.key).filter((k) => !shown.has(k)));
  watching.shown = new Set(list.rows(latest).map(list.key));
  watching.latest = null;
  draw(latest);
  document.title = baseTitle();
  for (const row of document.querySelectorAll('#page tr[data-key]')) if (fresh.has(row.dataset.key)) row.classList.add('is-new-row');
  tableCard()?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
});
