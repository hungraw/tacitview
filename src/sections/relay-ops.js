// Relayed ops: what Tacit's settle relay did per day (/views/relay-ops, from /relay/economics).
import { number, escapeHtml, metrics } from '../format.js';

export default {
  id: 'relay-ops',
  sources: ['relayOps'],
  render({ relayOps: d }) {
    const rows = (d.days || []).map((x) => `<tr><th scope="row">${escapeHtml(x.date)}</th><td class="num">${number(x.settled)}</td><td class="num">${number(x.proveOnly)}</td><td class="num">${number(x.priced)} / ${number(x.unpriced)}</td><td class="num">${Number(x.gasEth).toFixed(4)}</td></tr>`).join('');
    return {
      html: `<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Day (UTC)</th><th scope="col">Settled</th><th scope="col">Prove-only</th><th scope="col">Fee priced / not</th><th scope="col">Gas ETH</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No days reported.</td></tr>'}</tbody></table></div>`,
      about: ['Why a relayer', `Relayed transactions are sent by Tacit's relayer (${d.relayers[0].slice(0, 10)}…), so in a relayed transaction the on-chain sender is the relayer, not the user. Deposits and withdrawals at the pool boundary still show the user's address.`],
      asOf: '',
      source: '/relay/economics',
    };
  },
};
