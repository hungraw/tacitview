// Pure formatting helpers shared by all sections. No DOM, no network.

export const number = (value) => value != null && value !== '' && Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US').format(Number(value)) : '—';
export const shortId = (value, size = 8) => value ? `${String(value).slice(0, size)}…${String(value).slice(-size)}` : '—';
const ring = '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.1"/>';
export const doneIcon = (label) => `<svg class="state-icon" viewBox="0 0 16 16" role="img" aria-label="${label}"><title>${label}</title>${ring}<path d="M5.2 8.2 7.2 10.2 10.9 6.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const waitIcon = (label) => `<svg class="state-icon" viewBox="0 0 16 16" role="img" aria-label="${label}"><title>${label}</title>${ring}<path d="M5.3 8h.01M8 8h.01M10.7 8h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

// Chain badges: one system for every chain the explorer shows. Each is the same tinted circle with the chain's own
// glyph in its brand hue: Bitcoin's B, Ethereum's diamond, Base's square (base/brand-kit), Robinhood Chain's feather
// (robinhood.com/chain). Sizes: default (22px, lists) and 'sm' (1.25em, in text such as footers).
const GLYPH = {
  btc: '<svg viewBox="0 0 12 16"><path d="M3 3v10M2 3h5a2.5 2.5 0 0 1 0 5H3m0 0h4.5a2.5 2.5 0 0 1 0 5H2M5 1.2V3m2-1.8V3M5 13v1.8m2-1.8v1.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  eth: '<svg viewBox="0 0 10 16"><path d="M5 .8 1 8.2 5 10.6 9 8.2zM1 9.2 5 15.2 9 9.2 5 11.6z" fill="currentColor"/></svg>',
  base: '<svg viewBox="0 0 1280 1280"><rect width="1280" height="1280" rx="101" fill="currentColor"/></svg>',
  tacit: '<svg viewBox="7 4 18 23"><path d="M17.5 7L13 22.5Q13 25 18 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 11L21 11" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  rh: '<svg viewBox="-1 -1 67 86"><g fill="currentColor"><path d="M41.2967 18.946H24.3318C23.7179 18.946 23.1598 19.1707 22.7692 19.7325L10.6035 34.9005C8.81775 37.1477 8.3713 39.2262 8.3713 42.2037V57.7088C4.40909 68.8882 1.89783 76.4722 0.0562398 83.3259C-0.111178 83.7753 0.112046 84 0.502686 84H2.34428C2.67911 84 2.95814 83.8315 3.12556 83.5506C17.0212 47.9338 32.1446 30.294 41.6316 19.7325C42.0222 19.2831 41.8548 18.946 41.2967 18.946Z"/><path d="M41.7991 1.47599C40.7388 1.98159 40.1807 2.09394 39.0646 3.10515C34.0421 7.43084 30.6937 10.8577 27.5128 14.2284C27.1222 14.6216 27.2896 15.0149 27.8476 15.0149H46.6542C48.3842 15.0149 49.3887 16.0261 49.3887 17.7676V39.1152C49.3887 39.6769 49.8351 39.8455 50.1699 39.3399L61.4985 24.4527C63.3401 22.0371 63.8982 21.3068 64.4004 17.9361C65.0701 12.9924 64.6795 5.40844 61.7217 2.26248C59.0989 -0.546415 47.268 -0.658771 41.7991 1.47599Z"/><path d="M44.6454 23.2157C32.982 36.3051 23.8856 50.0687 15.4589 66.6412C15.2357 67.0906 15.5147 67.4277 16.017 67.2591L33.4284 61.8661C35.3816 61.3605 36.4977 60.4616 37.4464 58.8886L45.2034 46.0239C45.3709 45.6868 45.4267 45.2936 45.4267 45.0127V23.5528C45.4267 22.991 45.036 22.7663 44.6454 23.2157Z"/></g></svg>',
};
const CHAIN_NAME = { btc: 'Bitcoin', eth: 'Ethereum', base: 'Base', rh: 'Robinhood', tacit: 'Tacit' };
export const chainBadge = (key, size = '') => `<span class="chain-badge is-${key}${size ? ` ${size}` : ''}" role="img" aria-label="${CHAIN_NAME[key] || key}" title="${CHAIN_NAME[key] || key}">${GLYPH[key] || GLYPH.eth}</span>`;
// A block height with its chain's icon in place of "Ethereum block" / "Bitcoin block"; the full words stay in the tooltip.
export const ethAt = (n) => `<span class="at" title="Ethereum block ${number(n)}">${chainBadge('eth', 'sm')}${number(n)}</span>`;
export const btcAt = (n) => `<span class="at" title="Bitcoin block ${number(n)}">${chainBadge('btc', 'sm')}${number(n)}</span>`;
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
// 4663 verified via eth_chainId on rpc.mainnet.chain.robinhood.com.
export const CHAIN_NAMES = { 1: 'Ethereum', 8453: 'Base', 4663: 'Robinhood' };
export const chainName = (chain) => CHAIN_NAMES[Number(chain)] || `Chain ${chain ?? '—'}`;

export function formatAmount(value, decimals) {
  if (value == null || value === '') return '—';
  const raw = String(value);
  if (!/^\d+$/.test(raw)) return `${raw} raw units`;
  const digits = raw.replace(/^0+(?=\d)/, '');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) return `${new Intl.NumberFormat('en-US').format(BigInt(digits))} raw units`;
  if (decimals === 0) return `${new Intl.NumberFormat('en-US').format(BigInt(digits))} (raw)`;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '') || '0';
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${new Intl.NumberFormat('en-US').format(BigInt(whole))}.${fraction}` : new Intl.NumberFormat('en-US').format(BigInt(whole));
}

// Integer base units -> fixed decimals, truncated (never rounded up). formatUnits('7881650442957887592', 18, 4) -> '7.8816'.
export function formatUnits(value, decimals, places = 4) {
  const raw = String(value ?? '');
  if (!/^\d+$/.test(raw)) return '—';
  const big = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = new Intl.NumberFormat('en-US').format(big / base);
  if (places <= 0) return whole;
  const fraction = String(big % base).padStart(decimals, '0').slice(0, places);
  return `${whole}.${fraction}`;
}

// A decimal string or number shown with a fixed number of decimals, grouped: fixed('1107.7776', 2) -> '1,107.78'.
export function fixed(value, places = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat('en-US', { minimumFractionDigits: places, maximumFractionDigits: places }).format(n) : '—';
}

export function relativeTime(seconds) {
  const age = Math.max(0, Math.floor(Date.now() / 1000 - Number(seconds)));
  if (!Number.isFinite(age)) return '—';
  if (age < 60) return `${age}s ago`;
  if (age < 3600) return `${Math.floor(age / 60)}m ago`;
  if (age < 86400) return `${Math.floor(age / 3600)}h ago`;
  return `${Math.floor(age / 86400)}d ago`;
}

// ConfidentialPool event names for people, shared by the lists, the block page and the tx page.
export const POOL_EVENT = { leaves: 'Note created', nullifiers: 'Note spent', wrap: 'Wrap', crossOut: 'Cross-out', lockLeaves: 'Lock created', bitcoinConsumed: 'Bitcoin notes consumed', cdpPosition: 'CDP position', assetRegistered: 'Asset registered', other: 'Other event' };

// An age given in seconds ("seen 517,878s ago" reads badly): 8m ago, 6d ago.
export const ago = (seconds) => (Number.isFinite(Number(seconds)) ? relativeTime(Date.now() / 1000 - Number(seconds)) : '—');

export const clock = (ms) => Number.isFinite(Number(ms)) ? new Date(Number(ms)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '—';
// Explorer marks, single colour (currentColor), shown next to the id they link to. Etherscan: official circle mark (etherscan.io brand assets);
// mempool.space: its square mark (mempool/mempool svg-images component), gradient flattened to opacity.
const ETHERSCAN = '<svg class="site-logo" viewBox="219 213 294 294" aria-hidden="true"><path fill="currentColor" d="M280.433,353.152A12.45,12.45,0,0,1,292.941,340.7l20.737.068a12.467,12.467,0,0,1,12.467,12.467v78.414c2.336-.692,5.332-1.43,8.614-2.2a10.389,10.389,0,0,0,8.009-10.11V322.073a12.469,12.469,0,0,1,12.467-12.47h20.779a12.47,12.47,0,0,1,12.467,12.470v90.276s5.2-2.106,10.269-4.245a10.408,10.408,0,0,0,6.353-9.577V290.9a12.466,12.466,0,0,1,12.465-12.467h20.779A12.468,12.468,0,0,1,450.815,290.9v88.625c18.014-13.055,36.271-28.758,50.759-47.639a20.926,20.926,0,0,0,3.185-19.537,146.6,146.6,0,0,0-136.644-99.006c-81.439-1.094-148.744,65.385-148.736,146.834a146.371,146.371,0,0,0,19.500,73.450,18.560,18.560,0,0,0,17.707,9.173c3.931-.346,8.825-.835,14.643-1.518a10.383,10.383,0,0,0,9.209-10.306V353.152"/><path fill="currentColor" opacity=".5" d="M279.981,478.91A146.808,146.808,0,0,0,513.153,360.169c0-3.381-.157-6.724-.383-10.049-53.642,80-152.686,117.405-232.790,128.793"/></svg>';
const MEMPOOL = '<svg class="site-logo" viewBox="0 0 125 127" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="10" d="M119.7 110.3c0 6-4.8 10.5-10.5 10.5H15.5C9.6 120.8 5 116 5 110.3V16.5C5 10.6 9.7 6 15.5 6h93.7c5.8 0 10.5 4.7 10.5 10.5z"/><path fill="currentColor" opacity=".35" d="M5 63.5h114.7v46.8c0 5.8-4.7 10.5-10.5 10.5H15.5C9.7 120.8 5 116 5 110.3z"/><rect fill="currentColor" x="88" y="14" width="22" height="98.5" rx="3"/></svg>';
// tacitscan.io: its ring-and-t mark (tacitscan.io/tacit.svg).
const TACITSCAN = '<svg class="site-logo" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M17.5 7L13 22.5Q13 25 18 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 11L21 11" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const SITES = { Etherscan: ETHERSCAN, 'mempool.space': MEMPOOL, 'tacitscan.io': TACITSCAN };
// A link to another explorer: its logo where we have one (name kept for screen readers and the tooltip), else the name.
export const siteLink = (href, name) => SITES[name]
  ? `<a class="site-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer" title="${escapeHtml(name)}" aria-label="${escapeHtml(name)}">${SITES[name]}</a>`
  : link(href, name);
// Asset name as tacitscan writes it: ticker plus the first 8 hex of the asset id (tickers are not unique).
export const assetName = (ticker, id) => `${ticker || 'unnamed'}#${String(id || '').slice(0, 8)}`;
// An asset's logo, served same-origin by /api/asset-icon; the ticker's first letter shows until it loads,
// and stays if the asset has no image (main.js hides images that fail).
export const assetIcon = (id, ticker, size = '') => `<span class="asset-icon ${size}" aria-hidden="true"><span>${escapeHtml(String(ticker || '?').replace(/^t(?=[A-Z])/, '').charAt(0).toUpperCase())}</span><img src="/api/asset-icon?id=${encodeURIComponent(id)}" alt="" loading="lazy" decoding="async"></span>`;
export const link = (href, text) => `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(text)}</a>`;

// A term with a short explanation on hover or keyboard focus. Sources for the wording: SPEC.md, the contracts' comments.
export const TERMS = {
  'note created': "A new private note added to the pool's note tree. Its amount and owner are hidden.",
  'note spent': "A nullifier was published: some note was spent. For an owned note, which one stays hidden; a bearer or Bitcoin-homed note's spend can be matched to its leaf.",
  wraps: 'Public tokens deposited into the pool and turned into private notes. The deposit amount is public.',
  'cross-outs': 'Pool notes burned on Ethereum to be released on Bitcoin, honoured once final.',
  confirming: 'Fewer than 24 confirmations on Bitcoin: too recent for the bridge to accept.',
  awaiting: 'Deep enough (24 confirmations). Waits for the paced relay and the next reflection: the SP1 proof that carries Bitcoin state to Ethereum.',
  attested: 'Proven to Ethereum by the SP1 bridge. Its Tacit activity can now settle in the pool.',
  'relay tip': 'The newest Bitcoin header stored on Ethereum. Tacit paces the relay to save gas, so it trails Bitcoin a little.',
  'sp1 attested': 'The Bitcoin height the pool has proven with an SP1 zero-knowledge proof. It can reach the relay tip minus 24.',
  'burns minted': 'Bitcoin notes burned for the bridge, against the mints already paid out on Ethereum.',
  'reflection digest': 'Digest of the Bitcoin state the pool last proved (attestedReflectionDigest on the pool contract).',
  'cbtc backing': 'Real BTC locked on Bitcoin behind cBTC, as proven to the pool.',
  'cusd outstanding': 'cUSD borrowed against collateral and not yet repaid.',
  'tacit chain': "The pool's history as hash-linked blocks. Each block is one Ethereum transaction that changed notes; anyone can rebuild it from the logs.",
  envelope: 'A Tacit operation written into a Bitcoin transaction: the op code and its data sit in a Taproot script.',
};
// A small "i" that opens a card with a title and an explanation (hover, focus or tap), in place of a paragraph on the
// page. about: [title, text] or plain text. end: kept for card-head use (the card is nudged on screen either way).
const INFO_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 9.2v4.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="10" cy="6.4" r="1.05" fill="currentColor"/></svg>';
export const info = (about, { end = false } = {}) => {
  const [title, text] = Array.isArray(about) ? about : ['', about];
  return `<span class="info${end ? ' end' : ''}" tabindex="0" role="note" aria-label="${escapeHtml(title ? `${title}. ${text}` : text)}">${INFO_ICON}<span class="tip" aria-hidden="true">${title ? `<b>${escapeHtml(title)}</b>` : ''}${escapeHtml(text)}</span></span>`;
};

export function term(label, key = label.toLowerCase()) {
  const tip = TERMS[key];
  if (!tip) return escapeHtml(label);
  return `<span class="term" tabindex="0">${escapeHtml(label)}<span class="tip" role="tooltip">${escapeHtml(tip)}</span></span>`;
}

// ---- Time pill: one timestamp in the reader's chosen form (age, local time or UTC). Hover or focus shows all three;
// picking one applies it to every timestamp and is remembered on this device. main.js wires the clicks.
export const TIME_MODES = ['ago', 'local', 'utc'];
const TIME_LABEL = { ago: 'Age', local: 'Local', utc: 'UTC' };
let timeMode = 'local';
try { const m = localStorage.getItem('tacit-explorer-time'); if (TIME_MODES.includes(m)) timeMode = m; } catch { /* storage is optional */ }
export const getTimeMode = () => timeMode;
export function setTimeMode(mode) {
  if (!TIME_MODES.includes(mode)) return;
  timeMode = mode;
  try { localStorage.setItem('tacit-explorer-time', mode); } catch { /* storage is optional */ }
}
export function timeIn(mode, seconds) {
  const d = new Date(seconds * 1000);
  if (mode === 'ago') return relativeTime(seconds);
  if (mode === 'utc') return d.toUTCString().replace(' GMT', ' UTC');
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(d);
}
export const timePill = (seconds) => (seconds ? `<span class="time" data-t="${Number(seconds)}"><button type="button" class="time-pill" aria-haspopup="true">${escapeHtml(timeIn(timeMode, seconds))}</button><span class="time-pop" role="menu">${TIME_MODES.map((m) => `<button type="button" role="menuitemradio" aria-checked="${m === timeMode}" data-mode="${m}"><b>${TIME_LABEL[m]}</b><span>${escapeHtml(timeIn(m, seconds))}</span></button>`).join('')}</span></span>` : '—');

// ---- Bitcoin amounts in the reader's unit (Settings): sats or BTC ----
export const AMOUNT_MODES = ['sats', 'btc'];
let amountMode = 'sats';
try { const m = localStorage.getItem('tacit-explorer-amount'); if (AMOUNT_MODES.includes(m)) amountMode = m; } catch { /* storage is optional */ }
export const getAmountMode = () => amountMode;
export function setAmountMode(mode) {
  if (!AMOUNT_MODES.includes(mode)) return;
  amountMode = mode;
  try { localStorage.setItem('tacit-explorer-amount', mode); } catch { /* storage is optional */ }
}
export const btcAmount = (sats) => {
  if (sats == null || !Number.isFinite(Number(sats))) return '—';
  return amountMode === 'btc' ? `${(Number(sats) / 1e8).toFixed(8).replace(/\.?0+$/, '')} BTC` : `${number(sats)} sats`;
};

// A status pill: a short capitalised label on a soft tint of its tone. Tones: ok, info, warn, bad, muted.
export const pill = (label, tone = 'muted', title = '') => `<span class="pill is-${tone}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</span>`;
// A row of labelled values for a card head: "Median wait [1 s]  Proof [26 s]". Values are already formatted text.
export const metrics = (items) => `<span class="metrics">${items.filter(Boolean).map(([label, value, tone]) => `<span class="metric"><span>${escapeHtml(label)}</span><b${tone ? ` class="is-${tone}"` : ''}>${escapeHtml(value)}</b></span>`).join('')}</span>`;
// First letter upper case ("idle, no candidate" → "Idle, no candidate").
export const sentence = (s) => { const t = String(s ?? '').trim(); return t && !/^[a-z]+[A-Z]/.test(t) ? t[0].toUpperCase() + t.slice(1) : t; }; // cBTC stays cBTC

// A duration in seconds as a ticking countdown: "37 d 01:23:45", or "01:23:45" under a day.
export function countdown(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const hms = [h, m, x].map((n) => String(n).padStart(2, '0')).join(':');
  return d ? `${d} d ${hms}` : hms;
}
