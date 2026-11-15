// Activity strip on the Tacit chain page: one thin tick per block over the last ~16 hours, notes created rising above
// the line and notes spent dropping below it. Loaded after the page is shown (/views/chain-activity), so it never
// holds the table back. Hovering (or tapping) shows which block a tick is; clicking opens it.
import { detail } from './data/api.js';
import { number } from './format.js';

export const activityCard = () => `<section class="card activity" id="activity" aria-label="Tacit chain activity">
  <header class="card-head"><h2>Activity</h2><span class="card-head-end"><span class="status" id="activity-status"></span></span></header>
  <div class="activity-body">${skeleton()}</div></section>`;

// Placeholder in the strip's own shape: faint ticks above and below a line, then the axis and key rows.
function skeleton() {
  let ticks = '', seed = 7;
  for (let i = 0; i < 90; i++) {
    seed = (seed * 9301 + 49297) % 233280; const r = seed / 233280;
    if (r < 0.45) continue;
    const x = (4 + i * 11).toFixed(1), up = 6 + r * 20, down = 6 + ((r * 7) % 1) * 18;
    ticks += `<rect x="${x}" y="${(32 - up).toFixed(1)}" width="2.6" height="${up.toFixed(1)}" rx="1.3"/><rect x="${x}" y="36" width="2.6" height="${down.toFixed(1)}" rx="1.3"/>`;
  }
  return `<div class="activity-skel" aria-hidden="true"><svg class="activity-svg" viewBox="0 0 1000 68" preserveAspectRatio="none"><line x1="0" x2="1000" y1="34" y2="34"/>${ticks}</svg>
    <div class="activity-axis">${'<i></i>'.repeat(5)}</div><div class="activity-key"><i></i><i></i></div></div><span class="sr-only">Loading activity</span>`;
}

const clock = (t) => new Date(t * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function draw(d) {
  const body = document.querySelector('#activity .activity-body');
  if (!body) return;
  const blocks = (d.blocks || []).filter((b) => b.t).sort((a, b) => a.t - b.t);
  if (blocks.length < 2) { body.innerHTML = '<p class="empty">Not enough recent blocks to draw.</p>'; return; }
  const t0 = blocks[0].t, t1 = blocks.at(-1).t, span = Math.max(1, t1 - t0);
  const max = Math.max(1, ...blocks.map((b) => Math.max(b.n, b.s)));
  const W = 1000, mid = 34, room = 28;
  const x = (t) => 4 + ((t - t0) / span) * (W - 8);
  const ticks = blocks.map((b) => {
    const X = x(b.t).toFixed(1);
    const up = b.n ? `<rect x="${X}" y="${(mid - 2 - (b.n / max) * room).toFixed(1)}" width="2.6" height="${((b.n / max) * room).toFixed(1)}" rx="1.3" class="up"/>` : '';
    const down = b.s ? `<rect x="${X}" y="${mid + 2}" width="2.6" height="${((b.s / max) * room).toFixed(1)}" rx="1.3" class="down"/>` : '';
    return `<g data-i="${blocks.indexOf(b)}">${up}${down}</g>`;
  }).join('');
  const hours = span / 3600;
  const created = blocks.reduce((a, b) => a + b.n, 0), spent = blocks.reduce((a, b) => a + b.s, 0);
  const labels = [0, 0.25, 0.5, 0.75, 1].map((f) => `<span>${clock(t0 + span * f)}</span>`).join('');
  body.innerHTML = `<div class="activity-plot"><svg class="activity-svg" viewBox="0 0 ${W} 68" preserveAspectRatio="none" role="img" aria-label="Notes created and spent per Tacit chain block over the last ${hours.toFixed(0)} hours"><line x1="0" x2="${W}" y1="${mid}" y2="${mid}" class="axis"/>${ticks}</svg><span class="act-guide" hidden></span><div class="act-tip" hidden></div></div>
    <div class="activity-axis">${labels}</div>
    <div class="activity-key"><span><i class="up"></i>notes created <b>${number(created)}</b></span><span><i class="down"></i>notes spent <b>${number(spent)}</b></span></div>`;
  hover(body.querySelector('.activity-plot'), blocks, x, W);
  const status = document.getElementById('activity-status');
  if (status) status.textContent = `Last ${hours < 1.5 ? `${Math.round(hours * 60)} min` : `${Math.round(hours)} h`} · ${number(blocks.length)} blocks`;
}

// Hover (or tap) anywhere on the strip: a guide snaps to the nearest block and a small card names it. Click opens the
// block; on touch screens the first tap shows the card and its link opens the block.
function hover(plot, blocks, x, W) {
  if (!plot) return;
  const guide = plot.querySelector('.act-guide'), tip = plot.querySelector('.act-tip');
  let current = null;
  const nearest = (clientX) => {
    const r = plot.getBoundingClientRect(), vx = ((clientX - r.left) / r.width) * W;
    let best = null, bestD = Infinity;
    for (const b of blocks) { const d = Math.abs(x(b.t) - vx); if (d < bestD) { bestD = d; best = b; } }
    return bestD <= 24 ? best : null;
  };
  const show = (b) => {
    if (b === current) return;
    current = b;
    plot.querySelector('g.is-on')?.classList.remove('is-on');
    if (!b) { guide.hidden = true; tip.hidden = true; return; }
    plot.querySelector(`g[data-i="${blocks.indexOf(b)}"]`)?.classList.add('is-on');
    const pct = (x(b.t) + 1.3) / W * 100;
    guide.style.left = `${pct}%`;
    tip.innerHTML = `<a href="#/chain/${b.h}"><b>Block ${number(b.h)}</b><span>${b.n} created · ${b.s} spent</span><small>${clock(b.t)}</small></a>`;
    guide.hidden = false; tip.hidden = false;
    const w = tip.offsetWidth, pw = plot.offsetWidth, left = Math.min(Math.max(0, (pct / 100) * pw - w / 2), pw - w);
    tip.style.left = `${left}px`;
  };
  plot.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') show(nearest(e.clientX)); });
  plot.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') show(null); });
  plot.addEventListener('click', (e) => {
    if (e.target.closest('.act-tip a')) return; // the card's own link
    const b = nearest(e.clientX);
    if (!b) return;
    if (e.pointerType === 'mouse' || matchMedia('(hover: hover)').matches) location.hash = `#/chain/${b.h}`;
    else show(b);
  });
}

// Called after the Tacit chain page is drawn: fills the strip once its data arrives.
export function fillActivity() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  setTimeout(() => {
    if (!document.getElementById('activity')) return;
    detail('chain-activity', '').then(draw, () => {
      const body = document.querySelector('#activity .activity-body');
      if (body) body.innerHTML = '<p class="empty">Activity could not load right now.</p>';
    });
  }, 0);
}
