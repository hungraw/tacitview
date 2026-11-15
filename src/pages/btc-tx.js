// Bitcoin transaction page (/views/btc-tx).
import { escapeHtml, number, shortId, link, relativeTime, siteLink, assetIcon, timePill, btcAmount, assetName, chainBadge, info } from '../format.js';
import { pageHead, kvTable, privacyPanel, bridgeStrip } from './common.js';
import { opPrivacy } from '../privacy-ops.js';

const addr = (a) => (a ? `<a href="#/address/${escapeHtml(a)}"><code>${escapeHtml(shortId(a, 8))}</code></a>` : '<span class="muted">no address</span>');

export function renderBtcTx(d) {
  const e = d.envelope;
  const chips = [[e ? `${e.name || 'unknown op'} · ${e.code}` : 'no Tacit envelope', 'btc'], [d.confirmed ? 'confirmed' : 'unconfirmed', d.confirmed ? 'ok' : 'warn']];
  // A trade (SPEC §3.5) spends inputs of two parties, so "an output to an input's address" may be the price paid to
  // the seller, not change. SPEC does not fix which output is which, so these outputs are not labelled change.
  const trade = /^T_(AXFER|PREAUTH_BID)/.test(e?.name || '');
  const reuse = !trade && d.vout.find((o) => o.reusesInput && !o.note);
  const priv = e ? opPrivacy(e.name) : { hidden: [], note: '' };
  const io = (side, list) => list.map((x) => `<div class="io-item ${x.note || (side === 'in' && e && x.n > 0) ? 'is-note' : ''}"><span class="io-main"><strong>${side === 'in' ? (x.envelope ? `Envelope reveal (vin ${x.n})` : e ? `Asset input (vin ${x.n})` : `Input ${x.n}`) : (x.note ? `Recipient · note ${x.n}${d.asset?.ticker ? ` · ${escapeHtml(assetName(d.asset.ticker, d.asset.id))}` : ''}` : x.reusesInput ? (trade ? `To an input's address (output ${x.n})` : "Sender's change") : `Output ${x.n}`)}</strong>${addr(x.address)}</span><span class="io-val num">${btcAmount(x.value)}${x.note ? '<small>amount hidden</small>' : x.reusesInput ? `<small>${trade ? 'public: a payment or change' : 'same address as an input'}</small>` : ''}</span></div>`).join('');
  const layout = e?.layout ? `<section class="card"><header class="card-head"><h2>Envelope</h2><span class="card-head-end"><span class="status">${number(e.payloadBytes)}-byte payload</span>${info(['Where this layout comes from', 'SPEC §3.4. The part sizes add up to the payload exactly.'], { end: true })}</span></header>
    <div class="layoutbar">${e.layout.map((p) => `<span style="flex:${p.bytes} 0 auto" class="seg seg-${p.part.split(' ')[0]}" title="${escapeHtml(`${p.part}: ${p.bytes} bytes`)}">${escapeHtml(p.part)} · ${number(p.bytes)}</span>`).join('')}</div></section>` : '';
  return [
    pageHead({ crumbs: [['Bitcoin', '#/'], d.height ? [`Block ${number(d.height)}`, `#/block/${d.height}`] : ['Mempool'], ['Transaction']], title: 'Transaction', id: d.txid, chips, icon: chainBadge('btc', 'lg'), links: [siteLink(`https://mempool.space/tx/${d.txid}`, 'mempool.space'), siteLink(`https://tacitscan.io/tx/${d.txid}`, 'tacitscan.io')] }),
    d.height ? bridgeStrip({ confirmations: d.confirmations, bridge: d.bridge, height: d.height }) : '',
    `<div class="grid grid-3-2">`,
    kvTable([
      ['Status', d.confirmed ? `Confirmed · ${number(d.confirmations)} confirmations` : 'Unconfirmed'],
      d.height && ['Block', `<a href="#/block/${d.height}">${number(d.height)}</a>`, { mono: true }],
      ['Time', timePill(d.time)],
      ['Tacit op', e ? `${escapeHtml(e.name || 'unknown')} (${escapeHtml(e.code)})` : 'None: not a Tacit envelope'],
      d.asset && ['Asset', `<a class="asset-name" href="#/asset/${escapeHtml(d.asset.id)}">${assetIcon(d.asset.id, d.asset.ticker)}${escapeHtml(assetName(d.asset.ticker, d.asset.id))}</a>${d.asset.verified ? ' <span class="badge ok">Verified</span>' : ''} · <code>${escapeHtml(shortId(d.asset.id, 6))}</code>`],
      e?.outputs != null && ['Notes created', number(e.outputs), { mono: true }],
      ['Fee', `${btcAmount(d.fee)} · ${d.feeRate != null ? d.feeRate.toFixed(1) : '—'} sat/vB`, { mono: true }],
      ['Size', `${number(d.size)} B · ${number(d.vsize)} vB · ${number(d.weight)} WU`, { mono: true }],
      d.mint && ['Minted on Ethereum', d.mint.tx ? `<a href="#/eth/${escapeHtml(d.mint.tx)}"><code>${escapeHtml(shortId(d.mint.tx, 6))}</code></a>${d.mint.block ? ` · block ${number(d.mint.block)}` : ''}` : `<span class="muted">${d.time && Date.now() / 1000 - d.time < 31 * 3600 ? 'Not yet' : 'Not in the last ~31 h of pool logs'}</span>`], // the pool logs read cover ~31 h, so a younger burn is simply not minted yet
      d.signerKey && ['Signer key', `<code>${escapeHtml(shortId(d.signerKey, 10))}</code>`],
    ]),
    privacyPanel(
      [d.asset && ['asset id', shortId(d.asset.id, 6)], e?.outputs != null && ['notes created', String(e.outputs)], ['inputs spent', `${d.vin.length} outpoints`], ['addresses', `all ${d.vin.length + d.vout.length}, note outputs included`], ['fee', btcAmount(d.fee)]].filter(Boolean),
      e ? priv.hidden : ['nothing: this is a plain Bitcoin transaction'],
      [priv.note, reuse ? `Change went back to the sender (${shortId(reuse.address, 6)}), so that address is linkable.` : ''].filter(Boolean).join(' '),
    ),
    `</div>`,
    `<section class="card"><header class="card-head"><h2>Inputs and outputs</h2><span class="status">${d.vin.length} in · ${d.vout.length} out · fee ${btcAmount(d.fee)}</span></header>
      <div class="io"><div class="io-col">${io('in', d.vin)}</div><svg class="io-arrow" width="64" height="24" viewBox="0 0 64 24" aria-hidden="true"><path d="M4 12h48" stroke="currentColor" stroke-width="1.5"/><path d="M46 6l8 6-8 6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg><div class="io-col">${io('out', d.vout)}</div></div></section>`,
    layout,
  ].join('');
}
