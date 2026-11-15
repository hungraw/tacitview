// Detail and list page renderers, loaded on demand so a visit only downloads the code of the page it shows.
// view -> [module, export]. early.js (generated) preloads the current page's module from this table.
export const PAGE_MODULES = {
  'btc-tx': ['./pages/btc-tx.js', 'renderBtcTx'],
  'eth-tx': ['./pages/eth-tx.js', 'renderEthTx'],
  'btc-block': ['./pages/btc-block.js', 'renderBtcBlock'],
  'chain-block': ['./pages/chain-block.js', 'renderChainBlock'],
  asset: ['./pages/asset.js', 'renderAsset'],
  'chain-list': ['./pages/lists.js', 'renderChainList'],
  'block-list': ['./pages/lists.js', 'renderBlockList'],
  'pool-events': ['./pages/lists.js', 'renderPoolEvents'],
  'asset-list': ['./pages/lists.js', 'renderAssetList'],
  traced: ['./pages/lists.js', 'renderTraced'],
  'btc-address': ['./pages/btc-address.js', 'renderBtcAddress'],
  // search results: an EVM address or name page, a Tacit address page, or the general search page
  footprint: [['./pages/address.js', 'renderAddress'], ['./pages/tacit-address.js', 'renderTacitAddress'], ['./pages/search.js', 'renderSearch']],
};

const loaded = new Map();
const load = (path) => { if (!loaded.has(path)) loaded.set(path, import(path)); return loaded.get(path); };

// The render function for a view (a promise; resolves at once after the first load).
export async function pageRenderer(view) {
  const entry = PAGE_MODULES[view];
  if (!entry) throw new Error(`No page for ${view}`);
  if (view !== 'footprint') return (await load(entry[0]))[entry[1]];
  const [address, tacit, search] = await Promise.all(entry.map(([p]) => load(p)));
  return (d) => (d.kind === 'evm-address' || (d.kind === 'name' && d.items?.some((i) => i.title === 'Name')) ? address.renderAddress(d)
    : d.kind === 'tacit-address' && d.items?.some((i) => i.title === 'Unified Tacit address') ? tacit.renderTacitAddress(d) : search.renderSearch(d));
}

// After the first page is shown, fetch every page's code in idle time (about 20 KB compressed), so later taps never
// wait for code. Skipped in data-saver mode.
let warmed = false;
export function warmPages() {
  if (warmed || typeof window === 'undefined' || navigator.connection?.saveData) return;
  warmed = true;
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1500));
  idle(() => { for (const view of Object.keys(PAGE_MODULES)) pageRenderer(view).catch(() => {}); }, { timeout: 4000 });
}
