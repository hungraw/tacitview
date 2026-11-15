// Section registry. Each section module exports:
//   id        DOM prefix: #<id>-body, #<id>-status, #<id>-asof, #<id>-source
//   sources   data source names (src/data/api.js) it needs
//   optional  (optional) subset of sources it can render without
//   render(values, fetchedAt) -> { html, status, asOf, source }   asOf: context only (no fetch time); source: hover hint   fetchedAt: { name: ms } when each source was fetched
// renderSection() isolates failures: one broken source or render shows an error in that section only.

import { escapeHtml, clock, info, pill } from '../format.js';
import { meta } from '../data/api.js';
import checksMini from './checks-mini.js';
import btcBlocks from './btc-blocks.js';
import bridge from './bridge.js';
import confidential from './confidential.js';
import envelopes from './envelopes.js';
import tacitChain from './tacit-chain.js';
import evmPools from './evm-pools.js';
import ethAssets from './eth-assets.js';
import relayOps from './relay-ops.js';
import checks from './checks.js';
import bridgeFlight from './bridge-flight.js';
import privacy from './privacy.js';
import activity from './activity.js';
import withdrawalCheck from './withdrawal-check.js';
import proverBoard from './prover-board.js';
import assets from './assets.js';
import pools from './pools.js';
import farms from './farms.js';
import bridgeLag from './bridge-lag.js';
import measuredPrivacy from './measured-privacy.js';
import bridgeBurns from './bridge-burns.js';

export const SECTIONS = [btcBlocks, bridge, confidential, checksMini, envelopes, tacitChain, evmPools, ethAssets, relayOps, checks, bridgeFlight, privacy, activity, proverBoard, assets, pools, farms, bridgeLag, measuredPrivacy, bridgeBurns, withdrawalCheck];

const node = (id) => document.getElementById(id);
const set = (id, text) => { const el = node(id); if (el) el.textContent = text; };
const setHtml = (id, html) => { const el = node(id); if (el) el.innerHTML = html; };

// New tiles fade in; tiles that were already there slide from their old place to their new one (FLIP), so a new
// block or pool event pushes the grid along instead of every tile jumping at once.
const moving = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : null;
function slideTiles(body, before, keyOf) {
  for (const t of body.querySelectorAll('.tile')) {
    const old = before.get(keyOf(t));
    if (!old) { t.classList.add('is-new'); continue; }
    if (moving?.matches) continue;
    const now = t.getBoundingClientRect();
    const dx = old.left - now.left, dy = old.top - now.top;
    if (!dx && !dy) continue;
    // Same row: slide along it. Wrapped to the next row: come in from the left of the new row (a long diagonal
    // trip across the grid reads as noise).
    const from = Math.abs(dy) < 2 ? { transform: `translate(${dx}px, 0)` } : { transform: `translate(${-(now.width + 8)}px, 0)`, opacity: 0 };
    t.animate([from, { transform: 'none', opacity: 1 }], { duration: 520, easing: 'cubic-bezier(.2, .7, .2, 1)' });
  }
}

export function renderSection(section, data) {
  const optional = new Set(section.optional || []);
  const missing = section.sources.filter((name) => !optional.has(name) && !data[name]?.data);
  const body = node(`${section.id}-body`);
  if (missing.length) {
    const raw = missing.map((name) => data[name]?.error?.message || '').join(' ');
    const reason = /429|cooling down/i.test(raw) ? 'A data source is rate-limiting us right now.' : /timeout|abort/i.test(raw) ? 'A data source took too long to answer.' : 'A data source is unavailable right now.';
    // Keep the last good render if there is one (and say it is older); otherwise show the reason in place of the body.
    if (!body?.dataset.rendered) body.innerHTML = `<p class="empty">${escapeHtml(reason)} It will retry automatically.</p>`;
    set(`${section.id}-status`, 'error');
    set(`${section.id}-asof`, body?.dataset.rendered ? `Showing earlier data · ${escapeHtml(reason)}` : `Retrying · ${clock(Date.now())}`);
    return { ok: false };
  }
  try {
    const values = Object.fromEntries(section.sources.map((name) => [name, data[name]?.data ?? null]));
    // Stale: this browser fell back to its copy, the body says an upstream answer was a fallback, or the server's own
    // copy is over five minutes old (past every view's cache and the CDN's revalidate window). The time shown is when the data was built, not when this page asked for it.
    const ageOf = (name) => meta.get(data[name]?.data || {})?.dataAt || data[name]?.savedAt;
    const stale = section.sources.some((name) => data[name]?.stale || data[name]?.data?.stale === true || meta.get(data[name]?.data || {})?.serverStale || Date.now() - (ageOf(name) || Date.now()) > 300_000);
    // A source the server could not read is named in the footer (views send it as `gaps`), not left as blank cells.
    const gaps = [...new Set(section.sources.flatMap((name) => data[name]?.data?.gaps || []))];
    const fetchedAt = Object.fromEntries(section.sources.map((name) => [name, ageOf(name)]));
    const out = section.render(values, fetchedAt);
    // Tiles that were not on screen before (a new block, a new pool event) get a short arrival cue.
    // Tiles are keyed (data-key: a block height, or tx:logIndex for a pool event; a pool tx can emit several events).
    const keyOf = (t) => t.dataset.key || t.getAttribute('href');
    const before = body.dataset.rendered ? new Map([...body.querySelectorAll('.tile')].map((t) => [keyOf(t), t.getBoundingClientRect()])) : null;
    const seen = before ? new Set(before.keys()) : null;
    // Unchanged data leaves the DOM alone (no flash, hover and open popovers survive a refresh).
    const changed = body._html !== out.html;
    if (changed) {
      // Values marked data-roll jump when a refresh changes them: up in green, down in red.
      const before = new Map([...body.querySelectorAll('[data-roll]')].map((el) => [el.dataset.roll, el.textContent]));
      body.innerHTML = out.html;
      for (const el of body.querySelectorAll('[data-roll]')) {
        const old = before.get(el.dataset.roll);
        if (old == null || old === el.textContent) continue;
        const num = (t) => Number(String(t).replace(/[^\d.-]/g, ''));
        el.classList.add(num(el.textContent) >= num(old) ? 'roll-up' : 'roll-down');
        setTimeout(() => el.classList.remove('roll-up', 'roll-down'), 1200);
      }
      body._html = out.html;
      if (seen) slideTiles(body, before, keyOf);
      else { body.classList.add('just-ready'); setTimeout(() => body.classList.remove('just-ready'), 600); } // first data only: fade in over the skeleton
    }
    body.dataset.rendered = '1';
    setHtml(`${section.id}-status`, `${stale ? pill('Stale', 'warn', 'Showing an older copy: a source is not answering right now') : out.status || ''}${out.about ? info(out.about, { end: true }) : ''}`);
    setHtml(`${section.id}-asof`, [out.asOf, gaps.length ? `unavailable right now: ${escapeHtml(gaps.join(', '))}` : ''].filter(Boolean).join(' · ')); // section-built HTML, values escaped at source
    // Right side of the footer: just the time the data was fetched. Where it came from is a hover hint, not text.
    const times = Object.values(fetchedAt).filter(Boolean);
    const foot = document.getElementById(`${section.id}-source`);
    const pageClock = document.getElementById('page-updated');
    if (foot) { foot.textContent = times.length && !pageClock ? clock(Math.max(...times)) : ''; foot.title = out.source ? `Source: ${out.source}` : ''; }
    // Pages with one clock by the title: it shows the newest data time across the page's cards.
    if (pageClock && times.length) {
      const t = Math.max(...times, Number(pageClock.dataset.t) || 0);
      pageClock.dataset.t = String(t);
      pageClock.textContent = `Updated ${clock(t)}`;
    }
    return { ok: true, changed };
  } catch (error) {
    console.error(`Section ${section.id} failed to render`, error);
    body.innerHTML = `<p class="empty">Could not render this section: ${escapeHtml(error.message)}</p>`;
    set(`${section.id}-status`, 'error');
    return { ok: false };
  }
}
