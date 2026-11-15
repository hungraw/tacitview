// Page controller: live pages (home and section pages) poll and render their sections; list and detail pages
// load once per visit. Search, copy buttons and the theme toggle live here too.
import { loadSource, detail, peekSource, peekDetail } from './data/api.js';
import { initFilters } from './filters.js';
import { watchList } from './live-lists.js';
import { escapeHtml, setTimeMode, getTimeMode, timeIn, shortId, countdown } from './format.js';
import { initSettings, refreshPaused } from './settings.js';
import { SECTIONS, renderSection } from './sections/index.js';
import { parseRoute, routeForQuery } from './router.js';
import { buildLayout } from './layouts.js';
import { pageRenderer, warmPages } from './page-modules.js';
import { notFound, bridgeStrip } from './pages/common.js';
import { annotateAddresses } from './names.js';
import './connector.js';

const REFRESH_MS = 15000;
const $ = (id) => document.getElementById(id);
let inFlight = false;
let route = parseRoute();

// Only the sections on screen are rendered, and only their sources are fetched. A request made while a load is
// running (e.g. switching pages) runs right after it, so a new page never waits for the next poll.
let rerun = false;
// Refresh indicator (header arc + // pulse): only when a refresh brings something new, or loading is slow.
// It always runs whole laps and fades out over the end of the last one, so it never snaps off.
let syncTimer = 0, syncStart = 0;
const LAP_MS = 700; // one // swap; it repeats while loading and stops only at the end of a swap, right stroke darker
const SLOW_MS = 350;
function syncOn() {
  clearTimeout(syncTimer);
  if (!document.body.classList.contains('syncing')) { syncStart = Date.now(); document.body.classList.add('syncing'); }
}
function syncOff() {
  if (!document.body.classList.contains('syncing')) return;
  const elapsed = Date.now() - syncStart;
  const end = Math.max(1, Math.ceil(elapsed / LAP_MS)) * LAP_MS;
  syncTimer = setTimeout(() => document.body.classList.remove('syncing'), end - elapsed);
}
async function loadAll({ force = false } = {}) {
  if (route.kind !== 'live') return;
  if (refreshPaused() && document.querySelector('[id$="-body"][data-rendered]')) return; // Settings › Refresh: paused (first load still runs)
  if (inFlight) { rerun = true; return; }
  const present = SECTIONS.filter((s) => document.getElementById(`${s.id}-body`));
  if (!present.length) return;
  inFlight = true;
  const slow = setTimeout(syncOn, SLOW_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  // Cards not drawn yet are drawn at once from what this browser saved last time (up to 15 min old; each card's
  // footer shows its time), then replaced as fresh answers arrive below.
  for (const section of present) {
    if (document.getElementById(`${section.id}-body`)?.dataset.rendered) continue;
    const saved = section.sources.map((n) => [n, peekSource(n, 15 * 60_000)]);
    if (saved.every(([n, e]) => e || (section.optional || []).includes(n))) renderSection(section, Object.fromEntries(saved.map(([n, e]) => [n, e ? { data: e.data, stale: false, savedAt: e.savedAt } : {}])));
  }
  try {
    // Each card is drawn as soon as its own sources arrive, so one slow source does not hold back the rest.
    const loads = new Map([...new Set(present.flatMap((s) => s.sources))].map((name) => [name,
      loadSource(name, { signal: controller.signal, force }).then((r) => [name, r], (error) => [name, { error }])]));
    let partial = false;
    await Promise.all(present.map(async (section) => {
      const data = Object.fromEntries(await Promise.all(section.sources.map((name) => loads.get(name))));
      if (section.sources.some((name) => data[name]?.data?.partial)) partial = true;
      // The page may have changed while loading: render only sections still on screen.
      if (!document.getElementById(`${section.id}-body`)) return;
      if (renderSection(section, data).changed) syncOn();
    }));
    annotateAddresses($('page'));
    scheduleRefill(partial); // part of a view was still loading on the server: look again soon
    warmPages();
  } catch (error) {
    console.error('Unable to load explorer data', error);
  } finally {
    clearTimeout(slow);
    clearTimeout(timeout);
    inFlight = false;
    syncOff();
    if (rerun) { rerun = false; loadAll(); }
  }
}

function markNav() {
  const here = route.kind === 'live' ? route.page : route.name === 'tacit-chain' || route.name === 'chain' ? 'tacit-chain' : null;
  for (const a of document.querySelectorAll('.nav a')) a.toggleAttribute('aria-current', a.dataset.page === here);
}

// Shaped like a detail page (title, chips, two cards) so the real page lands in the same place.
const DETAIL_SKELETON = `<div class="skel-page" aria-hidden="true"><div class="skeleton skel-line" style="width:120px"></div><div class="skeleton skel-title"></div><div class="skeleton skel-line" style="width:220px"></div><div class="skeleton skel-card"></div><div class="grid grid-3-2"><div class="skeleton skel-card tall"></div><div class="skeleton skel-card tall"></div></div></div><span class="sr-only">Loading</span>`;

// New content rises in once; replays on every page change.
function enter(el) { el.classList.remove('page-in'); void el.offsetWidth; el.classList.add('page-in'); }

// A Bitcoin tx or block that is not attested yet keeps updating: new confirmations fill in where they are,
// and a transaction that gets mined re-renders with its block.
let watchTimer = 0;
function watchConfirmations(r, hash, first) {
  clearTimeout(watchTimer);
  if (!['btc-tx', 'btc-block'].includes(r.view) || first.bridge?.state === 'attested') return;
  let lastHeight = first.height;
  const tick = async () => {
    if (location.hash !== hash || document.hidden || refreshPaused()) { if (location.hash === hash) watchTimer = setTimeout(tick, 30_000); return; }
    try {
      const d = await detail(r.view, r.id);
      if (location.hash !== hash) return;
      const page = $('page');
      const old = document.getElementById('bridge-strip');
      if (d.height && !lastHeight) { page.innerHTML = (await pageRenderer(r.view))(d); enter(page); annotateAddresses(page); } // just mined
      else if (old && d.height) {
        const settled = Number(old.dataset.filled || 0);
        const html = bridgeStrip({ confirmations: d.confirmations, bridge: d.bridge, height: d.height }, settled);
        const filled = Math.min(d.bridge?.confirmationsNeeded, Math.max(0, d.confirmations || 0));
        if (filled !== settled || old.dataset.state !== (d.bridge?.state || '')) old.outerHTML = html;
      }
      lastHeight = d.height;
      if (d.bridge?.state === 'attested') return;
    } catch { /* keep the page as it is; try again next tick */ }
    watchTimer = setTimeout(tick, 30_000);
  };
  watchTimer = setTimeout(tick, 30_000);
}

// At most one page refill pending: cleared before it is set, backing off (4.5 s, 9 s, 18 s; the 15 s poll covers the
// rest) and never while the tab is hidden, so a slow server is not met with a growing number of timers.
let refillTimer = 0, refillTries = 0;
function scheduleRefill(partial) {
  clearTimeout(refillTimer);
  if (!partial) { refillTries = 0; return; }
  if (document.hidden || refillTries >= 3) return;
  refillTimer = setTimeout(loadAll, 4_500 * 2 ** refillTries++);
}

function refill(r, hash, redraw, tries = 4) {
  setTimeout(async () => {
    if (location.hash !== hash || document.querySelector('#page .verify.is-open')) return; // never redraw over a check in use
    if (document.hidden) return; // a background tab asks again when the poll resumes
    try {
      const d = await detail(r.view, r.id);
      if (location.hash !== hash) return;
      const y = window.scrollY; redraw(d); window.scrollTo(0, y);
      if (d.partial && tries > 1) refill(r, hash, redraw, tries - 1);
    } catch { /* keep what is shown */ }
  }, 4_500);
}

async function showRoute() {
  route = parseRoute();
  markNav();
  const page = $('page');
  window.scrollTo(0, 0);
  if (route.kind === 'live') {
    page.innerHTML = buildLayout(route.page);
    page.dataset.layout = route.page;
    enter(page);
    document.title = route.page === 'home' ? 'tacitview · Tacit explorer' : `${route.page[0].toUpperCase()}${route.page.slice(1)} · tacitview`;
    loadAll();
    return;
  }
  delete page.dataset.layout;
  if (route.kind === 'invalid') { page.innerHTML = notFound(`"${route.id}" is not a page or a valid id.`); return; }
  const current = location.hash;
  const rendererP = pageRenderer(route.view); // this page's code, loaded on demand (early.js has usually preloaded it)
  rendererP.catch(() => {});
  let render = null;
  // Draw a page this browser fetched in the last 10 min at once (back/forward, a prefetched link), then refresh it.
  const draw = (data) => {
    // A 64-hex search that is a Bitcoin transaction gets the transaction page; an asset id gets the asset page.
    if (route.view === 'footprint' && data.kind === 'btc-txid-or-asset') {
      if (data.items?.some((i) => i.title.startsWith('Asset'))) { location.replace(`#/asset/${data.query.toLowerCase()}`); return false; }
      if (data.items?.some((i) => i.title === 'Bitcoin transaction')) { location.replace(`#/tx/${data.query.toLowerCase()}`); return false; }
    }
    page.innerHTML = render(data);
    const h1 = page.querySelector('h1')?.textContent || 'Detail';
    // Tabs and bookmarks tell pages apart: "Transaction 5736…2df4" rather than "Transaction" again and again.
    document.title = `${h1}${route.id && !h1.includes(route.id) && !/\d/.test(h1) ? ` ${shortId(route.id, 4)}` : ''} · tacitview`;
    annotateAddresses(page);
    initFilters(page);
    return true;
  };
  const early = peekDetail(route.view, route.id, 10 * 60_000);
  if (!early) page.innerHTML = DETAIL_SKELETON;
  const slow = setTimeout(syncOn, SLOW_MS);
  try {
    if (early) { render = await rendererP; if (location.hash !== current) return; if (!draw(early.data)) return; enter(page); }
    const [data, r] = await Promise.all([detail(route.view, route.id), rendererP]);
    render = r;
    if (location.hash !== current) return; // navigated away meanwhile
    if (data !== early?.data) {
      const y = window.scrollY;
      if (!draw(data)) return;
      if (early) window.scrollTo(0, y); else enter(page);
    }
    watchConfirmations(route, current, data);
    warmPages();
    const redraw = (d) => { page.innerHTML = render(d); annotateAddresses(page); initFilters(page); };
    if (route.kind === 'list') watchList(route, data, redraw);
    // Part of the page was still loading on the server (blocks decoding, a rate-limited source): ask again shortly and
    // redraw in place, a few times at most.
    if (data.partial) refill(route, current, redraw);
  } catch (error) {
    if (location.hash !== current) return;
    page.innerHTML = error.status === 404 ? notFound(error.message) : `<section class="card"><p class="empty">This page could not load right now. ${escapeHtml(friendly(error.message))}</p></section>`;
    document.title = `${error.status === 404 ? 'Not found' : 'Could not load'} · tacitview`; // not the previous page's title
  } finally {
    clearTimeout(slow);
    if (location.hash === current) syncOff(); // a newer page load owns the indicator now
  }
}

export function friendly(message = '') {
  if (/429|cooling down|rate/i.test(message)) return 'A data source is rate-limiting us; try again in a few seconds.';
  if (/timeout|aborted/i.test(message)) return 'A data source took too long to answer.';
  return 'A data source is unavailable.';
}

const focusPage = () => { const el = $('page'); el.setAttribute('tabindex', '-1'); el.focus({ preventScroll: true }); };
window.addEventListener('hashchange', () => { showRoute(); focusPage(); });
// The skip link must not change the hash: hashes are routes here.
document.querySelector('.skip').addEventListener('click', (event) => { event.preventDefault(); focusPage(); });

// ---- Search ----
const input = $('lookup-query');
const suggest = $('lookup-suggest');
// Recent searches above the examples, kept for this tab only (sessionStorage): closing the tab forgets what was
// looked up. Lists saved on the device by earlier versions are removed.
const RECENT_KEY = 'tacit-explorer-recent';
try { localStorage.removeItem(RECENT_KEY); } catch { /* storage is optional */ }
const recentList = () => { try { const v = JSON.parse(sessionStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 5) : []; } catch { return []; } };
function remember(q) {
  try { sessionStorage.setItem(RECENT_KEY, JSON.stringify([q, ...recentList().filter((x) => x !== q)].slice(0, 5))); } catch { /* storage is optional */ }
}
function renderRecent() {
  const box = $('lookup-recent');
  const items = recentList();
  box.innerHTML = items.length ? `<p>Recent</p><ul>${items.map((q) => `<li><button type="button" data-q="${escapeHtml(q)}"><code>${escapeHtml(q.length > 24 ? shortId(q, 8) : q)}</code><span></span></button></li>`).join('')}</ul>` : '';
}
// What a typed query will open, as one clickable row (Enter does the same).
function describeQuery(q) {
  const hash = routeForQuery(q);
  const r = parseRoute(hash);
  const id = r.id || q;
  const short = id.length > 28 ? shortId(id, 10) : id;
  if (r.kind === 'invalid') return null;
  if (r.view === 'btc-tx') return ['Bitcoin transaction', short];
  if (r.view === 'eth-tx') return ['Ethereum, Base or Robinhood transaction', short];
  if (r.view === 'btc-block') return [`Bitcoin block ${Number(id).toLocaleString('en-US')}`, ''];
  if (r.view === 'btc-address') return ['Bitcoin address', short];
  if (r.name === 'address' && /^0x/i.test(id)) return ['Ethereum address', short];
  if (r.name === 'address' && /^(tacit|tactt|tacrt)1/i.test(id)) return ['Tacit address', short];
  if (r.name === 'address') return [/@/.test(id) ? 'XNS name' : /\.wei$/.test(id) ? '.wei name' : /\.gwei$/.test(id) ? '.gwei name' : /\.base\.eth$/.test(id) ? 'Basename' : 'ENS name', short];
  if (/^[0-9a-f]{64}$/i.test(id)) return ['Transaction or asset', short];
  return ['Search assets and names', short];
}
function renderResult() {
  const box = $('lookup-result');
  const q = input.value.trim();
  const d = q ? describeQuery(q) : null;
  box.innerHTML = d ? `<p>Open</p><ul><li><button type="button" data-q="${escapeHtml(q)}"><code>${escapeHtml(d[1] || q)}</code><span>${escapeHtml(d[0])}</span></button></li></ul>` : '';
  return Boolean(d);
}
const syncSuggest = () => {
  const empty = !input.value.trim();
  suggest.classList.toggle('typing', !empty);
  const show = empty || renderResult();
  if (empty && !suggest.classList.contains('open')) renderRecent();
  suggest.classList.toggle('open', show);
};
const go = (q) => { const s = String(q).trim(); if (s) { remember(s); input.blur(); location.hash = routeForQuery(s); } };

$('lookup-form').addEventListener('submit', (event) => { event.preventDefault(); go(input.value); });
input.addEventListener('input', syncSuggest);
input.addEventListener('focus', syncSuggest);
suggest.addEventListener('mousedown', (event) => event.preventDefault()); // keep focus while picking
suggest.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-q]');
  if (button) { input.value = button.dataset.q; go(button.dataset.q); }
});
document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (event.key === '/' && !typing) { event.preventDefault(); input.focus(); }
  if (event.key === '?' && !typing) { event.preventDefault(); const d = $('keys'); if (d && !d.open) d.showModal(); }
  // ← and → step through blocks and list pages, as the pager arrows do.
  if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !typing && !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
    const link = document.querySelector(`#page :is(.pager, .pagination) a[data-nav="${event.key === 'ArrowLeft' ? 'prev' : 'next'}"]`);
    if (link) { event.preventDefault(); location.hash = link.getAttribute('href'); }
  }
  if (event.key === 'Escape' && document.activeElement === input) input.blur();
  // Arrow keys move between the search box and its suggestions.
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const items = [...suggest.querySelectorAll('button[data-q]')].filter((b) => b.offsetParent);
    const at = items.indexOf(document.activeElement);
    if (!items.length || (at < 0 && document.activeElement !== input)) return;
    event.preventDefault();
    const next = event.key === 'ArrowDown' ? at + 1 : at - 1;
    (next < 0 ? input : items[Math.min(next, items.length - 1)]).focus();
  }
});

// ---- Asset logos: an image that fails (no logo, gateway down) is removed, leaving the ticker's initial ----
document.addEventListener('error', (event) => { if (event.target.matches?.('.asset-icon img')) event.target.remove(); }, true);

// ---- Prefetch: pressing a link to a detail or list page starts loading its data before the click lands. Only a
// press counts: hovering or tabbing past an address must not send it to the server, since that would be a lookup the
// visitor never chose. detail() caches per id for 30s and shares in-flight requests.
// Each prefetch can cost the server upstream calls to rate-limited sources, so: a deliberate pause on the link, at
// most two in flight, and the same link not again for 30s. Data saver mode turns it off.
let prefetching = 0;
const prefetched = new Map(); // href -> time
function prefetch(href) {
  if (prefetching >= 2 || navigator.connection?.saveData) return;
  const r = parseRoute(href);
  if ((r.kind !== 'detail' && r.kind !== 'list') || !r.view || href === location.hash) return;
  const at = prefetched.get(href);
  if (at && Date.now() - at < 30_000) return;
  prefetched.set(href, Date.now());
  prefetching++;
  pageRenderer(r.view).catch(() => {});
  detail(r.view, r.id).catch(() => {}).finally(() => { prefetching--; });
}
const linkOf = (event) => event.target.closest?.('a[href^="#/"]');
// A press (touch or mouse) starts the fetch before the click lands, about 100-300ms earlier on a phone.
document.addEventListener('pointerdown', (event) => { const a = linkOf(event); if (a) prefetch(a.getAttribute('href')); }, { passive: true });

// ---- Time pills: pick a form for every timestamp ----
document.addEventListener('click', (event) => {
  const pick = event.target.closest('.time-pop button[data-mode]');
  if (!pick) return;
  setTimeMode(pick.dataset.mode);
  for (const t of document.querySelectorAll('.time[data-t]')) {
    t.querySelector('.time-pill').textContent = timeIn(getTimeMode(), Number(t.dataset.t));
    for (const b of t.querySelectorAll('[data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === getTimeMode()));
  }
  pick.closest('.time').querySelector('.time-pill').focus();
});

document.addEventListener('click', (event) => { if (event.target.closest('.keys-hint')) $('keys')?.showModal(); });
// The Verifier quick link: scroll to the card (its scroll-margin keeps it clear of the sticky menu).
document.addEventListener('click', (event) => {
  const jump = event.target.closest('[data-jump]');
  if (!jump) return;
  const target = document.getElementById(jump.dataset.jump);
  if (target) target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
});

// Tooltips (terms and "i" tips) are nudged sideways so they never run off the screen edge. Placed once when the
// pointer enters (or focus arrives), from the host's position and the tip's untransformed width, against the visible
// width (clientWidth leaves out the scrollbar), so the tip never chases the pointer or hides under the scrollbar.
const placeTip = (event) => {
  const host = event.target.closest?.('.info, .term');
  if (!host || (event.relatedTarget && host.contains(event.relatedTarget))) return; // moving inside the same host
  const tip = host.querySelector('.tip');
  if (!tip) return;
  const h = host.getBoundingClientRect(), w = tip.offsetWidth, view = document.documentElement.clientWidth, pad = 12;
  const left = h.left + h.width / 2 - w / 2;
  const dx = left + w > view - pad ? view - pad - (left + w) : left < pad ? pad - left : 0;
  tip.style.setProperty('--dx', `${Math.round(dx)}px`);
};
document.addEventListener('pointerover', placeTip, { passive: true });
document.addEventListener('focusin', placeTip);

// Live countdowns ([data-until] = unix seconds), ticked once a second while the tab is visible.
setInterval(() => {
  if (document.hidden) return;
  const now = Date.now() / 1000;
  for (const el of document.querySelectorAll('[data-until]')) el.textContent = countdown(Number(el.dataset.until) - now);
}, 1000);

// ---- Copy buttons ----
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-copy]');
  if (!button) return;
  const icon = button.classList.contains('copy-ico');
  let ok = true;
  try { await navigator.clipboard.writeText(button.dataset.copy); } catch { ok = false; }
  if (icon) { button.classList.add(ok ? 'is-copied' : 'is-failed'); setTimeout(() => button.classList.remove('is-copied', 'is-failed'), 1200); return; }
  button.textContent = ok ? 'Copied' : 'Copy failed';
  setTimeout(() => { button.textContent = 'Copy'; }, 1500);
});

// ---- Theme ----
initSettings({ onRerender: () => showRoute(), onResume: () => loadAll() });
// The refresh button by a page title: ask for every card's data again now, past the browser's short cache.
document.addEventListener('click', async (event) => {
  const button = event.target.closest('#page-refresh');
  if (!button || button.classList.contains('is-busy')) return;
  button.classList.add('is-busy');
  try { await loadAll({ force: true }); } finally {
    // Stop only at the end of a full turn, never mid-rotation.
    const svg = button.querySelector('svg');
    const stop = () => button.classList.remove('is-busy');
    if (svg?.getAnimations?.().length) svg.addEventListener('animationiteration', stop, { once: true }); else stop();
  }
});
showRoute();
// Poll only while the tab is visible; refresh at once when it comes back.
let timer = setInterval(loadAll, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  clearInterval(timer);
  if (document.visibilityState === 'visible') { loadAll(); timer = setInterval(loadAll, REFRESH_MS); }
});

// ---- Same-value highlight ----
// Pointing at a transaction or address marks every other link to it on the page, as Etherscan does, so repeated
// transactions in a list (one tx, several pool events) stand out.
let sameHref = null;
const SAME = /^#\/(tx|eth|address|chain)\//;
document.addEventListener('mouseover', (event) => {
  const link = event.target.closest?.('#page a[href]');
  const href = link && SAME.test(link.getAttribute('href')) ? link.getAttribute('href') : null;
  if (href === sameHref) return;
  for (const a of document.querySelectorAll('#page a.same')) a.classList.remove('same');
  sameHref = href;
  if (!href) return;
  const all = document.querySelectorAll(`#page a[href="${CSS.escape(href)}"]`);
  if (all.length > 1) for (const a of all) a.classList.add('same');
});
