// Which sections each live page shows, row by row. The home page stays small on purpose: the system at a glance,
// then one click to depth.
// A card: [section id, title, page the title links to (optional), 'dark' (optional)]. The card's title is the link to
// its full list, so the head keeps its right side for the card's figures. A list of cards in place of one
// stacks them in that grid cell.

export const LAYOUTS = {
  home: {
    rows: [
      // Wide screens: the bridge sits inside the ConfidentialPool card (it is on Ethereum), and a line runs from the
      // Bitcoin tip into it (src/connector.js).
      { cls: 'hero', cards: [['btc-blocks', 'Bitcoin blocks', '#/blocks'], ['bridge', 'Bridge', null, 'dark'], ['confidential', 'ConfidentialPool', '#/pool-events']] },
      { cls: 'grid-2', cards: [['envelopes', 'Envelopes', '#/blocks'], ['tacit-chain', 'Tacit chain', '#/tacit-chain']] },
      { cls: 'grid-1', cards: [['checks-mini', 'Verifier', '#/bridge']] },
    ],
  },
  bitcoin: {
    title: 'Bitcoin',
    rows: [
      { cls: 'grid-2', cards: [['btc-blocks', 'Bitcoin blocks', '#/blocks'], ['envelopes', 'Envelopes', '#/blocks']] },
      { cls: 'grid-2', cards: [['assets', 'Assets', '#/assets'], ['pools', 'Bitcoin AMM']] },
    ],
  },
  ethereum: {
    title: 'Ethereum',
    rows: [
      { cls: 'grid-2', cards: [['confidential', 'ConfidentialPool', '#/pool-events'], ['farms', 'Farms']] },
      { cls: 'grid-2', cards: [[['evm-pools', 'EVM pool'], ['withdrawal-check', 'Withdrawal check']], ['activity', 'EVM pool activity']] },
      { cls: 'grid-2', cards: [['eth-assets', 'Ethereum assets'], ['relay-ops', 'Relayed ops']] },
    ],
  },
  bridge: {
    title: 'Bridge',
    rows: [
      { cls: 'hero-2', cards: [['bridge', 'Bridge', null, 'dark'], ['bridge-flight', 'Services']] },
      { cls: 'grid-1', cards: [['bridge-burns', 'Burns in transit']] },
      { cls: 'grid-1', cards: [['bridge-lag', 'Bridge lag']] },
      { cls: 'grid-1', cards: [['checks', 'Verifier']] },
      { cls: 'grid-1', cards: [['prover-board', 'Prover board']] },
    ],
  },
  privacy: {
    title: 'Privacy',
    rows: [{ cls: 'grid-1', cards: [['measured-privacy', 'Measurement']] }, { cls: 'grid-1', cards: [['privacy', 'Privacy boundary']] }],
  },
};

const card = ([id, title, more, tone]) => `<article class="card${tone === 'dark' ? ' card-dark' : ''}" id="${id}"><header class="card-head"><h2>${more ? `<a class="title-link" href="${more}" title="Open the full list">${title}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></a>` : title}</h2><span class="card-head-end"><span class="status" id="${id}-status"></span></span></header><div class="card-body" id="${id}-body"><div class="skeleton" aria-hidden="true"></div><span class="sr-only">Loading</span></div><footer class="card-foot"><span id="${id}-asof"></span><span id="${id}-source"></span></footer></article>`;

export function buildLayout(name) {
  const layout = LAYOUTS[name];
  const refresh = '<button type="button" class="page-refresh" id="page-refresh" aria-label="Refresh the data on this page" title="Refresh"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v2.8h-2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
  // Every live page: one "Updated" time and a refresh button by the title (the home page has the row without a title).
  // Pages with a Verifier get a quick link to it beside the Updated time.
  const verifier = layout.rows.flatMap((r) => r.cards.flatMap((c) => (Array.isArray(c[0]) ? c : [c]))).find((c) => c[0] === 'checks' || c[0] === 'checks-mini');
  const jump = verifier ? `<button type="button" class="jump" data-jump="${verifier[0]}">Verifier<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v9.5M4 9l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : '';
  const meta = `<div class="page-meta">${jump}<span id="page-updated"></span>${refresh}</div>`;
  const head = `<header class="page-head has-meta${layout.title ? '' : ' no-title'}">${layout.title ? `<h1>${layout.title}</h1>` : ''}${meta}</header>`;
  const cell = (c) => (Array.isArray(c[0]) ? `<div class="stack">${c.map(card).join('')}</div>` : card(c));
  return head + layout.rows.map((row) => `<section class="grid ${row.cls}">${row.cards.map(cell).join('')}</section>`).join('');
}
