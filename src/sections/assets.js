// Mainnet Tacit assets (/views/asset-list: verified first, then by holders). Tickers are not unique, so ids are always shown.
import { number, escapeHtml, shortId, assetIcon, assetName, metrics } from '../format.js';

export default {
  id: 'assets',
  sources: ['assetList'],
  render({ assetList: d }) {
    const all = d.assets || [];
    const rows = all.slice(0, 6).map((a) => `<div class="row">${assetIcon(a.id, a.ticker)}<span class="row-main"><strong><a href="#/asset/${escapeHtml(a.id)}">${escapeHtml(assetName(a.ticker, a.id))}</a>${a.verified ? ' <span class="badge ok">Verified</span>' : ''}</strong><span><code>${escapeHtml(shortId(a.id, 6))}</code> · ${number(a.holders)} holder${a.holders === 1 ? "" : "s"}</span></span><span class="row-end muted">${number(a.transfers)} transfers</span></div>`).join('');
    return {
      html: `<div class="rows">${rows || '<p class="empty">None on mainnet.</p>'}</div>`,
      status: metrics([['On mainnet', number(all.length)]]),
      asOf: '',
      source: '/assets?network=mainnet',
    };
  },
};
