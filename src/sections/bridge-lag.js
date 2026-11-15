// Bridge lag over the last 24 hours (/views/bridge-lag): how many blocks the relay's view of Bitcoin trailed the real
// tip, drawn from the relay's own tip updates, and how far the attested height trailed it, sampled every ~30 min.
// A status pill rates the live series (healthy, behind, paused, stalled) and opens a menu that swaps in made-up series
// showing what a stalled relay or prover would look like.
import { number, escapeHtml, metrics, clock } from '../format.js';

const STEP = 600; // one sample every 10 minutes
let last = null, scenario = 'now';

const SCENARIOS = {
  healthy: { label: 'Healthy', note: 'Simulated. The relay stays a few blocks behind Bitcoin and attestation follows close to the 24-block minimum.' },
  relay: { label: 'Relay paused', note: 'Simulated. The relay stops posting Bitcoin headers, so both lines climb a block every ten minutes and burns stop moving.' },
  prover: { label: 'Prover stalled', note: 'Simulated. Headers keep arriving but no attestation is proven, so only the attested line climbs and burns wait at Relayed.' },
};

// Value of a step series [[time, height], …] at time t: the last point at or before t.
function at(series, t) {
  let v = null;
  for (const [ts, h] of series) { if (ts <= t) v = h; else break; }
  return v;
}

function series(d) {
  const times = [];
  for (let t = d.start; t <= d.end; t += STEP) times.push(t);
  if (scenario === 'now') {
    // The attested line from the sampled history (every ~30 min); an older server answer without it stays flat.
    const att = d.attestedSeries?.length > 1 ? d.attestedSeries : null;
    return { times, relay: times.map((t) => { const b = at(d.btc, t), r = at(d.relay, t); return b != null && r != null ? Math.max(0, b - r) : null; }), attested: att ? times.map((t) => { const b = at(d.btc, t), a = at(att, t); return b != null && a != null ? Math.max(0, b - a) : null; }) : times.map(() => d.btcTip - d.attested), flat: !att, attestedNow: d.btcTip - d.attested };
  }
  const saw = (i, lo, hi, per) => lo + ((i % per) / per) * (hi - lo);
  const relayOk = (i) => Math.round(saw(i, 1, 9, 18));
  const attOk = (i) => Math.round(24 + saw(i, 1, 9, 18) + saw(i, 0, 8, 30));
  const n = times.length, cut = Math.round(n * 0.6);
  const relay = times.map((_, i) => (scenario === 'relay' && i >= cut ? relayOk(cut) + (i - cut) : relayOk(i)));
  const attested = times.map((_, i) => (scenario !== 'healthy' && i >= cut ? attOk(cut) + (i - cut) : attOk(i)));
  return { times, relay, attested };
}

function plot(d) {
  const s = series(d);
  // Drawn at the size it shows, so labels stay readable: narrower on phones, with fewer time labels.
  const narrow = typeof window !== 'undefined' && window.innerWidth < 640;
  const W = narrow ? 360 : 1000, H = narrow ? 210 : 232, L = 30, R = 8, T = 24, B = 24; // T leaves room for the axis title
  const values = [...s.relay, ...(s.attested || []), s.attestedNow ?? 0, d.confirmations + 8].filter((v) => v != null);
  const top = Math.max(40, Math.ceil((Math.max(...values) + 1) / 10) * 10); // headroom: a peak never sits on the top edge
  const x = (i) => L + (i / (s.times.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - v / top) * (H - T - B);
  const line = (arr) => arr.map((v, i) => (v == null ? '' : `${i && arr[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)).join('');
  // What the numbers on the left count: Bitcoin blocks behind the Bitcoin tip.
  let g = `<text class="axis-title" x="2" y="10">Blocks</text>`;
  const tick = top > 80 ? 20 : 10;
  for (let v = 0; v <= top; v += tick) g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  for (let h = 0; h <= 24; h += narrow ? 12 : 6) {
    const i = Math.min(s.times.length - 1, Math.round((h * 3600) / STEP));
    const label = h === 24 ? 'now' : new Date(s.times[i] * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    g += `<text x="${x(i)}" y="${H - 6}" text-anchor="${h === 0 ? 'start' : h === 24 ? 'end' : 'middle'}">${label}</text>`;
  }
  g += `<line class="min" x1="${L}" x2="${W - R}" y1="${y(d.confirmations)}" y2="${y(d.confirmations)}"/>`;
  g += `<path class="relay" d="${line(s.relay)}"/>`;
  // The attested line (sampled every ~30 min; a faded flat line if the history could not be read), ending in a dot.
  if (s.attested) g += `<path class="att${s.flat ? ' is-flat' : ''}" d="${line(s.attested)}"/>`;
  if (s.attestedNow != null) g += `<circle class="att-dot" cx="${x(s.times.length - 1)}" cy="${y(s.attestedNow)}" r="4.5"/>`;
  return `<svg class="lag-svg${scenario === 'now' ? '' : ' is-sim'}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Blocks behind the Bitcoin tip over the last 24 hours">${g}</svg>`;
}

// Bridge health from the real series. Thresholds sit well above a normal day (measured 2026-11-14 over 24 h: relay
// 3 blocks behind typically, 8 at worst; attestation backlog 3 typically, 14 at worst; the longest quiet spell of
// either about 2 h). Orange: behind more than usual. Red: paused (relay) or stalled (prover).
const H3 = 3 * 3600;
function health(d) {
  const relayLag = d.btcTip - d.relayTip;
  const backlog = d.relayTip - d.confirmations - d.attested; // attestable blocks not attested yet
  const relayQuiet = d.end - (d.relay?.at(-1)?.[0] ?? d.end);
  const att = d.attestedSeries || [];
  let attChanged = att[0]?.[0] ?? d.end;
  for (let i = 1; i < att.length; i++) if (att[i][1] !== att[i - 1][1]) attChanged = att[i][0];
  const attQuiet = att.length > 1 ? d.end - attChanged : 0;
  const hrs = (s) => `${Math.floor(s / 3600)} h`;
  if (relayLag > 24 || (relayQuiet > H3 && relayLag > 3)) return { label: 'Relay paused', tone: 'bad', why: `The relay is ${number(relayLag)} blocks behind Bitcoin${relayQuiet > H3 ? ` and has not posted a header for ${hrs(relayQuiet)}` : ''}.` };
  if (backlog > 32 || (attQuiet > H3 && backlog > 0)) return { label: 'Prover stalled', tone: 'bad', why: `${number(backlog)} relayed blocks wait for attestation${attQuiet > H3 ? `, and none was attested for ${hrs(attQuiet)}` : ''}.` };
  if (relayLag > 12) return { label: 'Relay behind', tone: 'warn', why: `The relay is ${number(relayLag)} blocks behind Bitcoin, more than usual (normally under 10).` };
  if (backlog > 16) return { label: 'Attestation behind', tone: 'warn', why: `${number(backlog)} relayed blocks wait for attestation, more than usual (normally under 15).` };
  return { label: 'Healthy', tone: 'ok', why: `The relay is ${number(relayLag)} blocks behind Bitcoin and ${number(Math.max(0, backlog))} relayed blocks wait for attestation, both normal.` };
}
const SIM_HEALTH = { healthy: ['Healthy', 'ok'], relay: ['Relay paused', 'bad'], prover: ['Prover stalled', 'bad'] };

// The status pill opens a small menu: live data, or one of the simulated scenarios.
const CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function menu(d) {
  const live = scenario === 'now';
  const h = live ? health(d) : { label: SIM_HEALTH[scenario][0], tone: SIM_HEALTH[scenario][1], why: SCENARIOS[scenario].note };
  return `<details class="lag-sim"><summary class="lag-status is-${h.tone}" title="${escapeHtml(h.why)}">${escapeHtml(h.label)}${live ? '' : '<span class="lag-sim-tag">Simulated</span>'}${CHEVRON}</summary>
  <div class="lag-menu" role="menu"><p class="lag-menu-why">${escapeHtml(h.why)}</p><p class="lag-menu-head">Simulate</p><button type="button" role="menuitemradio" aria-checked="${live}" data-lag="now">Live <span>${clock(d.end * 1000)}</span></button>${Object.entries(SCENARIOS).map(([k, v]) => `<button type="button" role="menuitemradio" aria-checked="${scenario === k}" data-lag="${k}">${v.label} <span>Simulated</span></button>`).join('')}</div></details>`;
}

function body(d) {
  const sim = scenario !== 'now';
  const flatNow = !sim && !(d.attestedSeries?.length > 1);
  return `<div class="lag-top"><div class="lag-key"><span><i class="k-relay"></i>Relay</span><span><i class="k-att${flatNow ? ' is-flat' : ''}"></i>${flatNow ? "Attested, today's value" : 'Attested'}</span><span><i class="k-min"></i>${d.confirmations}-block minimum</span></div>${menu(d)}</div>
    <div class="lag-plot">${plot(d)}</div>${sim ? `<p class="note lag-note">${escapeHtml(SCENARIOS[scenario].note)}</p>` : ''}`;
}

export default {
  id: 'bridge-lag',
  sources: ['bridgeLag'],
  render({ bridgeLag: d }) {
    last = d;
    return {
      html: `<div class="lag" id="lag-root">${body(d)}</div>`,
      status: metrics([['Relay behind', `${number(d.btcTip - d.relayTip)} blocks`, 'eth'], ['Attested behind', `${number(d.btcTip - d.attested)} blocks`, 'btc']]),
      asOf: 'Last 24 hours',
      source: 'BitcoinLightRelay logs · Esplora block times · ConfidentialPool',
    };
  },
};

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('click', (event) => {
    const menu = document.querySelector('.lag-sim[open]');
    if (menu && !menu.contains(event.target)) menu.open = false; // a click elsewhere closes the menu
    const pick = event.target.closest('[data-lag]');
    if (!pick || !last) return;
    scenario = pick.dataset.lag;
    const root = document.getElementById('lag-root');
    if (root) root.innerHTML = body(last);
  });
}
