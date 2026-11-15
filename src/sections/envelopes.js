// Every Tacit envelope type, decoded here from the recent raw Bitcoin blocks; transfers still in the mempool on top
// (known from Tacit's hint list, each read and decoded from Bitcoin, /views/envelopes).
import { number, escapeHtml, shortId, relativeTime, assetName, metrics } from '../format.js';

const STATE = { attested: 'attested', eligible: 'awaiting reflection', confirming: 'confirming' };

export default {
  id: 'envelopes',
  sources: ['btcBlocks', 'envelopes'],
  optional: ['envelopes'],
  render({ btcBlocks: b, envelopes: e2 }) {
    const decoded = (b.blocks || []).filter((x) => !x.error).flatMap((x) => x.envelopes.map((e) => ({
      txid: e.txid, op: e.name || e.opcodeHex, ticker: e.ticker, assetId: e.assetId || null, height: x.height, when: x.time, state: STATE[x.bridge] || '',
    })));
    const seen = new Set(decoded.map((e) => e.txid));
    const pending = (e2?.rows || []).filter((r) => r.confirmed === false && !seen.has(r.txid)).map((r) => ({ txid: r.txid, op: r.op?.name || r.op?.code, ticker: r.ticker, assetId: r.assetId, pending: true, when: r.seenAt ? Math.floor(r.seenAt / 1000) : null }));
    const where = (e) => (e.pending ? `<span class="chip warn">In mempool</span>${e.when ? ` · seen ${relativeTime(e.when)}` : ''}` : `<a href="#/block/${e.height}">Block ${number(e.height)}</a>${e.state ? ` · ${escapeHtml(e.state)}` : ''}${e.when ? ` · ${relativeTime(e.when)}` : ''}`);
    const rows = [...pending, ...decoded].slice(0, 8 + Math.min(pending.length, 4)).map((e) => `<div class="row${e.pending ? ' is-pending' : ''}"><span class="row-main"><strong><code>${escapeHtml(e.op)}</code>${e.ticker ? ` <span class="btc">${escapeHtml(e.assetId ? assetName(e.ticker, e.assetId) : e.ticker)}</span>` : ''}</strong><span>${where(e)}</span></span><span class="row-end"><a href="#/tx/${escapeHtml(e.txid)}"><code>${escapeHtml(shortId(e.txid, 5))}</code></a></span></div>`).join('');
    return {
      html: `<div class="rows">${rows || '<p class="empty">None in recent blocks.</p>'}</div>`,
      status: pending.length ? metrics([['In mempool', number(pending.length)]]) : '',
      asOf: '',
      source: 'raw Bitcoin blocks, decoded here',
    };
  },
};
