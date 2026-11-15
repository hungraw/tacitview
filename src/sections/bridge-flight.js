// Bridge flow and prover services. Reuses the /reflection/status snapshot.
import { number, escapeHtml, ago, pill, sentence } from '../format.js';

const SERVICE = { settle: 'Settle', reflection: 'Reflection', 'eth-state': 'Ethereum state' };

export default {
  id: 'bridge-flight',
  sources: ['bridge', 'proverHealth', 'reflectionProof'],
  render({ bridge: b, proverHealth: h, reflectionProof: p }) {
    const stats = [
      ['Awaiting bundle', number(b.burnsAwaitingBundle)], ['Attested cross-outs', number(b.chain?.attestedCrossOutCount)], ['Attested consumed', number(b.chain?.attestedConsumedCount)],
    ].map(([k, v]) => `<div class="stat"><span>${k}</span><b class="num">${v}</b></div>`).join('');
    const services = Object.entries(h.services || {}).map(([name, s]) => {
      const up = s.healthy !== false;
      const state = String(s.status || 'unknown');
      const label = state.toLowerCase() === 'ok' ? 'OK' : sentence(state);
      const detail = sentence(String(s.note || '').replace(new RegExp(`^(${name}:\\s*)+`), '').replace(/\s+—\s+/g, ', ').replace(/0x[0-9a-f]{40,}/gi, (h) => `${h.slice(0, 6)}…${h.slice(-4)}`));
      return `<div class="svc-row"><span class="svc-name">${escapeHtml(SERVICE[name] || sentence(name))}</span>${pill(label, up ? 'ok' : 'bad')}<span class="svc-detail">${escapeHtml(detail)}</span><span class="svc-age">${ago(s.age_seconds)}</span></div>`;
    }).join('');
    return {
      html: `<div class="stats stats-3">${stats}</div>
        <div class="svc">${services ? `<div class="svc-row svc-headrow"><span>Service</span><span>Status</span><span>Detail</span><span>Updated</span></div>${services}` : '<p class="empty">No prover services returned.</p>'}</div>
        <div class="svc svc-roots"><div class="svc-row"><span class="svc-label">Reflection digest</span><code class="svc-wide">${escapeHtml(b.chain?.reflectionDigest || '—')}</code></div><div class="svc-row"><span class="svc-label">Pool note root</span><code class="svc-wide">${escapeHtml(b.chain?.currentRoot || '—')}</code></div></div>${p.proof ? `<p class="note">Latest published reflection proof: ${escapeHtml(JSON.stringify(p.proof).slice(0, 120))}</p>` : ''}`,
      status: h.healthy ? pill('Healthy', 'ok') : pill('Unhealthy', 'bad', (h.reasons || []).join(', ')),
      asOf: '',
      source: 'ConfidentialPool (digest, root, attested counts) · /reflection/status (burns, mints) · /prover-health',
    };
  },
};
