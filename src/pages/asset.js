// Asset page (/views/asset).
import { escapeHtml, number, shortId, formatAmount, siteLink, assetIcon, assetName } from '../format.js';
import { pageHead, kvTable } from './common.js';

// SPEC §3.3–3.4: a fair-launch etch (T_PETCH) has a public cap and public mints; a confidential etch hides the supply
// in a commitment unless the issuer publishes its opening, which Tacit's API then reports as an attestation.
function supply(d) {
  if (d.etchOp === 'T_PETCH') return 'public (fair launch: the cap and every mint are public)';
  if (d.supply != null) return `${formatAmount(d.supply, Number(d.decimals))} ${escapeHtml(d.ticker || '')} <span class="muted">· published by the issuer</span>`;
  return 'not published (Pedersen commitment)';
}

export function renderAsset(d) {
  const burns = d.burns.map((b) => `<tr><th scope="row"><a href="#/tx/${escapeHtml(b.txid)}"><code>${escapeHtml(shortId(b.txid, 6))}</code></a></th><td class="num">${formatAmount(b.amount, Number(d.decimals))} ${escapeHtml(d.ticker || '')}</td><td class="num">${b.height ? `<a href="#/block/${b.height}">${number(b.height)}</a>` : '—'}</td></tr>`).join('');
  return [
    pageHead({ crumbs: [['Bitcoin', '#/bitcoin'], ['Asset']], title: assetName(d.ticker, d.id), id: d.id, icon: assetIcon(d.id, d.ticker, 'lg'), links: [siteLink(`https://tacitscan.io/assets/${d.id}`, 'tacitscan.io')], chips: [...(d.etchOp ? [[d.etchOp, 'btc']] : []), [d.verified ? 'verified' : 'unverified', d.verified ? 'ok' : 'warn'], ...(d.mintable ? [['mintable', '']] : [['fixed supply', '']])] }),
    d.sameTicker.length ? `<p class="callout">${d.sameTicker.length} other mainnet asset${d.sameTicker.length === 1 ? '' : 's'} use the ticker ${escapeHtml(d.ticker)}${d.sameTicker.some((x) => x.verified) ? '' : '; this one is the verified asset'}. Tickers are not unique: identify an asset by its id.</p>` : '',
    `<div class="grid grid-3-2">`,
    kvTable([
      ['Asset id', `<code>${escapeHtml(d.id)}</code>`],
      ['Ticker', escapeHtml(d.ticker || '—')],
      ['Decimals', number(d.decimals), { mono: true }],
      ['Supply', supply(d)],
      ['Etch transaction', d.etchTxid ? `<a href="#/tx/${escapeHtml(d.etchTxid)}"><code>${escapeHtml(shortId(d.etchTxid, 8))}</code></a>` : '—'],
      d.etchedHeight && ['Etched at block', `<a href="#/block/${d.etchedHeight}">${number(d.etchedHeight)}</a>`],
      ['Holders · transfers', `${number(d.holders)} · ${number(d.transfers)}`, { mono: true }],
    ]),
    `<section class="card"><header class="card-head"><h2>Burns</h2><span class="card-head-end"><span class="status">burn amounts are public</span></span></header><div class="table-wrap"><table class="table"><thead><tr><th scope="col">Transaction</th><th scope="col">Amount</th><th scope="col">Block</th></tr></thead><tbody>${burns || '<tr><td colspan="3">No burns.</td></tr>'}</tbody></table></div></section>`,
    `</div>`,
  ].join('');
}
