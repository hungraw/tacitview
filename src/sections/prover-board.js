// Prover marketplace: queue, workers and recent proofs.
import { number, escapeHtml, shortId, relativeTime, ago, metrics } from '../format.js';

const name = (w) => escapeHtml(String(w.name || '').length > 16 ? shortId(w.name, 6) : (w.name || shortId(w.pubkey, 5)));

export default {
  id: 'prover-board',
  sources: ['proverBoard', 'proofPoolRecent'],
  render({ proverBoard: b, proofPoolRecent: p }) {
    const stats = [['Queued', b.queued], ['Claimed', b.claimed], ['Proved', b.proved], ['Failed', b.failed]].map(([k, v]) => `<div class="stat"><span>${k}</span><b class="num">${number(v)}</b></div>`).join('');
    const workers = (b.workers || []).slice(0, 5).map((w) => `<tr><th scope="row"><code title="${escapeHtml(w.name || w.pubkey || '')}">${name(w)}</code></th><td><span class="tags">${(w.programs || []).map((x) => `<span class="tag">${escapeHtml(x)}</span>`).join('')}</span></td><td class="num">${number(w.proved)}</td><td class="num${w.failed ? ' bad' : ' muted'}">${number(w.failed)}</td><td class="num muted">${ago(w.lastSeenSeconds)}</td></tr>`).join('');
    const recent = (p.proofs || []).slice(0, 4).map((x) => `<tr><th scope="row"><code data-addr="${escapeHtml(x.miner)}">${escapeHtml(shortId(x.miner, 5))}</code></th><td class="num">${number(x.points)}</td><td class="num">${number(x.secs)} s</td><td class="num muted">${relativeTime(Number(x.at) / 1000)}</td></tr>`).join('');
    const latency = metrics([b.recent?.waitP50 != null && ['Median wait', `${number(b.recent.waitP50)} s`], b.recent?.proveP50 != null && ['Median proof', `${number(b.recent.proveP50)} s`]]);
    return {
      html: `<div class="stats stats-4">${stats}</div>
        <h3 class="sub">Workers</h3>${workers ? `<div class="table-wrap"><table class="table table-tight"><thead><tr><th scope="col">Worker</th><th scope="col">Programs</th><th scope="col" class="num">Proved</th><th scope="col" class="num">Failed</th><th scope="col" class="num">Last seen</th></tr></thead><tbody>${workers}</tbody></table></div>` : '<p class="empty">No workers.</p>'}
        <h3 class="sub">Recent pool proofs</h3>${recent ? `<div class="table-wrap"><table class="table table-tight"><thead><tr><th scope="col">Prover</th><th scope="col" class="num">Points</th><th scope="col" class="num">Proving time</th><th scope="col" class="num">When</th></tr></thead><tbody>${recent}</tbody></table></div>` : '<p class="empty">No recent proofs.</p>'}`,
      status: latency,
      asOf: '',
      source: '/prover/board · /prover/pool/recent',
    };
  },
};
