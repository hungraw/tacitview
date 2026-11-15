// Labels for EVM addresses anywhere on the page: known Tacit contracts and relayers, then names (XNS, ENS, .wei, .gwei).
// Renderers mark an address with data-addr="0x…"; this batches the lookups (20 per call) and adds the label once.
import { detail } from './data/api.js';
import { escapeHtml } from './format.js';

const known = new Map(); // address -> { label, name } (null while loading)

export async function annotateAddresses(root = document) {
  const nodes = [...root.querySelectorAll('[data-addr]:not([data-named])')];
  const want = [...new Set(nodes.map((n) => n.dataset.addr.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a) && !known.has(a));
  for (let i = 0; i < want.length; i += 20) {
    const batch = want.slice(i, i + 20);
    batch.forEach((a) => known.set(a, null));
    try {
      const r = await detail('names', batch.join(','));
      for (const a of batch) known.set(a, r.names?.[a] || { label: null, name: null });
    } catch { batch.forEach((a) => known.delete(a)); }
  }
  for (const n of nodes) {
    const info = known.get(n.dataset.addr.toLowerCase());
    if (!info || n.dataset.named) continue; // another scan already labelled it
    n.dataset.named = '1';
    const text = info.name || info.label;
    if (!text) continue;
    const rows = [...(info.label ? [{ name: info.label, service: 'Tacit' }] : []), ...(info.names || []).map((x) => ({ name: x.name, service: SERVICE[x.system] || x.system, url: x.url }))];
    if (rows.length < 2) { n.insertAdjacentHTML('afterend', ` <span class="addr-name${info.name ? ' is-name' : ''}">${escapeHtml(text)}</span>`); continue; }
    // More than one name: the chip opens a small scrollable list of all of them.
    n.insertAdjacentHTML('afterend', ` <button type="button" class="addr-name is-name has-more" aria-expanded="false" data-names="${escapeHtml(JSON.stringify(rows))}">${escapeHtml(text)}<span class="more-count">+${rows.length - 1}</span></button>`);
  }
}

const SERVICE = { xns: 'XNS', ens: 'ENS', wns: 'Wei Name Service', gns: 'Gwei Name Service', base: 'Basenames' };

// ---- Names popover: one shared element, positioned next to the chip (fixed, so tables can't clip it) ----
let pop = null;
let owner = null;
let closeTimer = 0;
function openNames(button) {
  clearTimeout(closeTimer);
  if (owner === button) return;
  closeNames();
  const rows = JSON.parse(button.dataset.names || '[]');
  pop = document.createElement('div');
  pop.className = 'names-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Names for this address');
  pop.innerHTML = `<p>${rows.length} names</p><ul>${rows.map((r) => `<li>${r.url ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer">${escapeHtml(r.name)}</a>` : `<span>${escapeHtml(r.name)}</span>`}<small>${escapeHtml(r.service)}</small></li>`).join('')}</ul>`;
  document.body.append(pop);
  const box = button.getBoundingClientRect();
  const width = pop.offsetWidth;
  pop.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
  const below = box.bottom + 6 + pop.offsetHeight < window.innerHeight;
  pop.style.top = `${below ? box.bottom + 6 : box.top - 6 - pop.offsetHeight}px`;
  pop.addEventListener('mouseenter', () => clearTimeout(closeTimer));
  pop.addEventListener('mouseleave', () => { closeTimer = setTimeout(closeNames, 150); });
  requestAnimationFrame(() => pop?.classList.add('open'));
  owner = button;
  button.setAttribute('aria-expanded', 'true');
}
function closeNames() {
  clearTimeout(closeTimer);
  pop?.remove();
  owner?.setAttribute('aria-expanded', 'false');
  pop = null;
  owner = null;
}
const chip = (event) => event.target.closest?.('button.has-more');
document.addEventListener('mouseover', (event) => { if (chip(event) && matchMedia('(hover: hover)').matches) openNames(chip(event)); });
document.addEventListener('mouseout', (event) => { if (chip(event) && owner === chip(event)) closeTimer = setTimeout(closeNames, 150); });
document.addEventListener('click', (event) => {
  const button = chip(event);
  // A chip inside a link (an address that opens its page) follows the link; the full list is on that page.
  const link = button?.closest('a[href]');
  if (link) { closeNames(); location.hash = link.getAttribute('href'); return; }
  if (button) { if (owner === button && !matchMedia('(hover: hover)').matches) closeNames(); else openNames(button); return; }
  if (pop && !pop.contains(event.target)) closeNames();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && owner) { const b = owner; closeNames(); b.focus(); } });
window.addEventListener('scroll', closeNames, { passive: true });
window.addEventListener('hashchange', closeNames);
