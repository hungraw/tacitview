// Reader settings behind the header gear: theme, time form, Bitcoin amount unit, live refresh, name labels, and an
// optional Ethereum node on this computer for the block check. Stored per device (localStorage, optional); each change
// applies at once. "Clear data on this device" removes everything this site stored.
import { TIME_MODES, getTimeMode, setTimeMode, AMOUNT_MODES, getAmountMode, setAmountMode } from './format.js';
import { LOCAL_NODE, ethNode } from './own-node.js';

const store = {
  get: (k) => { try { return localStorage.getItem(`tacit-explorer-${k}`); } catch { return null; } },
  set: (k, v) => { try { if (v) localStorage.setItem(`tacit-explorer-${k}`, v); else localStorage.removeItem(`tacit-explorer-${k}`); } catch { /* storage is optional */ } },
};

const root = document.documentElement;
const dark = window.matchMedia('(prefers-color-scheme: dark)');

// kind: how the panel shows it. theme = small light/dark/system pictures; list = one row per option with a live example;
// pair = two side-by-side examples; switch = an on/off toggle with a line saying what it does.
const SETTINGS = [
  { key: 'theme', label: 'Theme', kind: 'theme', options: [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']], get: () => store.get('theme') || 'light', set: (v) => { store.set('theme', v); applyTheme(); } },
  { key: 'time', label: 'Time', kind: 'list', options: TIME_MODES.map((m) => [m, { ago: 'Age', local: 'Local', utc: 'UTC' }[m]]), example: (m) => { const d = new Date(); return m === 'ago' ? '12m ago' : m === 'utc' ? `${d.toISOString().slice(11, 16)} UTC` : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }, get: getTimeMode, set: setTimeMode, rerender: true },
  { key: 'amount', label: 'Bitcoin amounts', kind: 'pair', options: AMOUNT_MODES.map((m) => [m, m === 'btc' ? '0.0125 BTC' : '1,250,000 sats']), get: getAmountMode, set: setAmountMode, rerender: true },
  { key: 'refresh', label: 'Live refresh', kind: 'switch', on: 'live', off: 'paused', note: 'New blocks and events every 15s', get: () => store.get('refresh') || 'live', set: (v) => { store.set('refresh', v); root.dataset.refresh = v; } },
  { key: 'names', label: 'Names', kind: 'switch', on: 'show', off: 'hide', note: 'vitalik.eth next to 0xd8da…6045', get: () => store.get('names') || 'show', set: (v) => { store.set('names', v); root.dataset.names = v; } },
];

function nodePanel() {
  const v = ethNode();
  return `<div class="set-node"><p class="set-label" id="set-eth-node">Your Ethereum node</p>
    <form class="set-node-form"><input type="url" inputmode="url" name="node" placeholder="http://127.0.0.1:8545" value="${v.replace(/"/g, '&quot;')}" aria-labelledby="set-eth-node" spellcheck="false" autocomplete="off"><button type="submit" class="set-opt">${v ? 'Saved' : 'Use'}</button></form>
    <small class="set-hint">${v ? 'Block checks read Ethereum from this node, not from this site.' : 'Optional. Block checks then read Ethereum from your own node on this computer, not from this site.'}</small></div>
    <div class="set-clear-row"><button type="button" class="set-clear">Clear data on this device</button><small class="set-hint">Settings, filters and the last page data. Searches are only kept until the tab closes.</small></div>`;
}

const radio = (s, v, inner, cls) => `<button type="button" class="${cls}" role="radio" aria-checked="${s.get() === v}" data-key="${s.key}" data-value="${v}">${inner}</button>`;
function panel() {
  return SETTINGS.map((s) => {
    if (s.kind === 'switch') {
      const on = s.get() === s.on;
      return `<div class="set-switch"><span><b id="set-${s.key}">${s.label}</b><small>${s.note}</small></span><button type="button" class="switch" role="switch" aria-checked="${on}" aria-labelledby="set-${s.key}" data-key="${s.key}" data-value="${on ? s.off : s.on}"></button></div>`;
    }
    const body = s.kind === 'theme' ? s.options.map(([v, text]) => radio(s, v, `<i class="th-pic th-${v}" aria-hidden="true"></i>${text}`, 'th-opt')).join('')
      : s.kind === 'list' ? s.options.map(([v, text]) => radio(s, v, `<span>${text}</span><b>${s.example(v)}</b>`, 'set-opt')).join('')
      : s.options.map(([v, text]) => radio(s, v, `<b>${text}</b>`, 'set-opt')).join('');
    return `<div class="set-group"><p class="set-label" id="set-${s.key}">${s.label}</p><div class="set-${s.kind}" role="radiogroup" aria-labelledby="set-${s.key}">${body}</div></div>`;
  }).join('');
}

function applyTheme() {
  const mode = store.get('theme') || 'light';
  root.dataset.theme = mode === 'system' ? (dark.matches ? 'dark' : 'light') : mode;
}
export const refreshPaused = () => root.dataset.refresh === 'paused';

export function initSettings({ onRerender, onResume }) {
  applyTheme();
  dark.addEventListener('change', applyTheme);
  root.dataset.refresh = store.get('refresh') || 'live';
  root.dataset.names = store.get('names') || 'show';
  const button = document.getElementById('settings-toggle');
  const pop = document.getElementById('settings-pop');
  const render = () => {
    pop.innerHTML = panel() + nodePanel();
  };
  const open = (yes) => { pop.hidden = !yes; button.setAttribute('aria-expanded', String(yes)); if (yes) { render(); pop.querySelector('[aria-checked="true"]')?.focus(); } };
  button.addEventListener('click', () => open(pop.hidden));
  pop.addEventListener('click', (event) => {
    const b = event.target.closest('button[data-key]');
    if (!b) return;
    const s = SETTINGS.find((x) => x.key === b.dataset.key);
    const was = s.get();
    s.set(b.dataset.value);
    render();
    (pop.querySelector(`.switch[data-key="${s.key}"]`) || pop.querySelector(`[data-key="${s.key}"][aria-checked="true"]`))?.focus();
    if (s.rerender) onRerender();
    if (s.key === 'refresh' && was === 'paused' && b.dataset.value === 'live') onResume();
  });
  pop.addEventListener('submit', (event) => {
    event.preventDefault();
    const field = event.target.querySelector('input[name="node"]');
    const v = field.value.trim().replace(/\/$/, '');
    if (v && !LOCAL_NODE.test(v)) { field.setCustomValidity('Use a node on this computer, like http://127.0.0.1:8545'); field.reportValidity(); field.setCustomValidity(''); return; }
    store.set('eth-node', v);
    render();
    pop.querySelector('input[name="node"]')?.focus();
  });
  pop.addEventListener('click', (event) => {
    const clear = event.target.closest('.set-clear');
    if (!clear) return;
    for (const s of [localStorage, sessionStorage]) {
      try { for (let i = s.length - 1; i >= 0; i--) { const k = s.key(i); if (k?.startsWith('tacit-explorer')) s.removeItem(k); } } catch { /* storage is optional */ }
    }
    applyTheme(); root.dataset.refresh = 'live'; root.dataset.names = 'show';
    render();
    const b = pop.querySelector('.set-clear'); b.textContent = 'Cleared'; b.focus();
    onRerender();
  });
  document.addEventListener('click', (event) => { if (!pop.hidden && event.target.isConnected && !pop.contains(event.target) && !button.contains(event.target)) open(false); }); // a re-rendered choice is detached: not an outside click
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !pop.hidden) { open(false); button.focus(); } });
}
