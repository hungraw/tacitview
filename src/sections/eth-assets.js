// cBTC, cUSD and the public ERC-20s on Ethereum, read from the contracts (/views/eth-assets).
import { number, formatUnits, clock, term, ethAt } from '../format.js';

export default {
  id: 'eth-assets',
  sources: ['ethAssets'],
  render({ ethAssets: d }) {
    const c = d.counts;
    const rows = [
      ['cBTC backing', `${formatUnits(d.cbtc.backingSats, d.cbtc.decimals, 8)} BTC`, c ? `${number(c.locks)} live locks · ${number(c.mintedLocks)} minted cBTC` : 'real BTC locked on Bitcoin behind cBTC'],
      ['cUSD outstanding', `${formatUnits(d.cusd.outstanding, d.cusd.decimals, 2)} cUSD`, c ? `${number(c.openPositions)} open positions` : 'principal across open positions'],
      ...Object.entries(d.tokens).map(([name, t]) => [`${name} supply`, `${formatUnits(t.supply, t.decimals, name === 'tacBTC' ? 6 : 2)} ${name}`, `ERC-20 <code data-addr="${t.address}">${t.address.slice(0, 8)}…</code>`]),
    ].map(([k, v, note]) => `<div class="row"><span class="row-main"><strong>${term(k)}</strong><span>${note}</span></span><span class="row-end"><b class="num">${v}</b></span></div>`).join('');
    return {
      html: `<div class="rows">${rows}</div>`,
      about: ['Public totals', 'cBTC and cUSD balances inside the pool are hidden; these are public totals.'],
      asOf: '',
      source: 'ConfidentialPool · CollateralEngine · ERC-20 totalSupply',
    };
  },
};
