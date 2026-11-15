// Bitcoin-native AMM pools (/views/amm-pools), reserves formatted with each asset's decimals.
import { number, escapeHtml, shortId, formatAmount, metrics } from '../format.js';

const side = (s) => (s.ticker && s.decimals != null ? `${formatAmount(s.reserve, Number(s.decimals))} ${s.ticker}${s.verified ? '' : ' (unverified)'}` : `${number(s.reserve)} raw · ${shortId(s.id, 5)}`);

export default {
  id: 'pools',
  sources: ['ammPools'],
  render({ ammPools: d }) {
    const pools = d.pools || [];
    const rows = pools.map((p) => `<div class="row"><span class="row-main"><strong class="num">${escapeHtml(side(p.a))}</strong><strong class="num">${escapeHtml(side(p.b))}</strong><span><code>${escapeHtml(shortId(p.id, 6))}</code></span></span><span class="row-end muted">${number(p.feeBps)} bps</span></div>`).join('');
    return {
      html: `<div class="rows">${rows || '<p class="empty">None on mainnet.</p>'}</div>`,
      status: metrics([['On mainnet', number(pools.length)]]),
      asOf: '',
      source: '/amm/pools',
    };
  },
};
