// The Bitcoin-to-Ethereum line on the Home page (wide screens, layout B): from the Bitcoin tip pill in the Bitcoin
// blocks card, right, a rounded turn into the bridge card's rail, down through the relay tip to the SP1 attested
// point. Orange up to the relay while the relay trails Bitcoin; dashed alongside the 24-block gap. Drawn from the
// cards' own positions, so it follows every refresh and resize.
const NS = 'http://www.w3.org/2000/svg';
const R = 12; // radius of the turn

export function drawConnector() {
  const hero = document.querySelector('main .hero');
  if (!hero) return;
  let svg = hero.querySelector(':scope > svg.connector');
  const pill = hero.querySelector('#btc-blocks-status .metric b');
  const relay = hero.querySelector('[data-rail="relay"]'), sp1 = hero.querySelector('[data-rail="sp1"]'), gap = hero.querySelector('[data-rail="gap"]');
  const wide = window.matchMedia('(min-width: 1181px)').matches;
  if (!wide || !pill || !relay || !sp1 || !gap || !relay.offsetParent) { svg?.remove(); return; }
  if (!svg) { svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'connector'); svg.setAttribute('aria-hidden', 'true'); hero.append(svg); }
  const box = hero.getBoundingClientRect();
  const at = (el) => { const r = el.getBoundingClientRect(); return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2, r }; };
  const p = at(pill), a = at(relay), s = at(sp1), g = gap.getBoundingClientRect();
  const x0 = p.r.right - box.left + 4, y0 = p.y, X = a.x;
  // The dashed stretch is centred on the "24-block gap" label: as far above it as below, clear of the chips above.
  const chips = hero.querySelector('#bridge .rail-chips');
  const mid = g.top - box.top + g.height / 2;
  const above = chips ? chips.getBoundingClientRect().bottom - box.top + 6 : a.y + 10;
  const half = Math.max(10, Math.min(mid - above, s.y - 10 - mid));
  const gy = mid - half, gy2 = mid + half;
  const lagging = !relay.classList.contains('is-full');
  svg.setAttribute('width', String(Math.ceil(box.width)));
  svg.setAttribute('height', String(Math.ceil(box.height)));
  svg.innerHTML = `<path class="cn-in${lagging ? ' is-lag' : ''}" d="M${x0} ${y0}H${X - R}Q${X} ${y0} ${X} ${y0 + R}V${a.y}"/>`
    + `<path class="cn-run" d="M${X} ${a.y}V${gy}"/><path class="cn-gap" d="M${X} ${gy}V${gy2}"/><path class="cn-run" d="M${X} ${gy2}V${s.y}"/>`
    + `<circle class="cn-dot is-relay${relay.classList.contains('is-full') ? ' is-full' : ''}" cx="${X}" cy="${a.y}" r="4.5"/>`
    + `<circle class="cn-dot is-sp1${sp1.classList.contains('is-full') ? ' is-full' : ''}" cx="${X}" cy="${s.y}" r="4.5"/>`;
}

// A short timer rather than an animation frame: frames pause in a background tab, which would leave the line undrawn.
let timer = 0;
const schedule = () => { clearTimeout(timer); timer = setTimeout(drawConnector, 60); };
if (typeof window !== 'undefined' && typeof MutationObserver !== 'undefined') {
  window.addEventListener('resize', schedule);
  document.addEventListener('visibilitychange', schedule);
  new MutationObserver(schedule).observe(document.querySelector('main') || document.body, { childList: true, subtree: true });
}
