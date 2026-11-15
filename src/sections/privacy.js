// Privacy boundary (/views/privacy): what Tacit's spec says is public and hidden, then real transactions showing
// which of their fields are public. The spec is Tacit's SPEC.md, section 11 and the sections it names.
import { escapeHtml, shortId, sentence } from '../format.js';

const SPEC_URL = 'https://github.com/src-company/tacit/blob/main/SPEC.md';
const tidy = (s) => sentence(String(s).replace(/\s*\((?:§|in |leaf )[^)]*\)/g, '').replace(/, in the Wrap log/, ''));
const GENERIC = new Set(['tx', 'block', 'log index', 'time', 'chain']); // every transaction has these

function record(op) {
  const m = /^Bitcoin (\S+)$/.exec(op);
  return m ? `Bitcoin <code>${escapeHtml(m[1])}</code>` : escapeHtml(op);
}

export default {
  id: 'privacy',
  sources: ['privacy'],
  render({ privacy: d }) {
    const pub = [...(d.specPublic || []), ...(d.specAlsoPublic || [])].map((x) => `<li>${escapeHtml(tidy(x))}</li>`).join('');
    const hid = (d.specHidden || []).map((x) => `<li>${escapeHtml(tidy(x))}</li>`).join('');
    const rows = (d.rows || []).map((row) => {
      const href = row.example?.id ? (/^0x/.test(row.example.id) ? `#/eth/${escapeHtml(row.example.id)}` : `#/tx/${escapeHtml(row.example.id)}`) : '';
      const fields = row.public.map(([k]) => k).filter((k) => !GENERIC.has(k)).map(tidy).join(', ');
      return `<tr><th scope="row">${record(row.op)}</th><td>${href ? `<a href="${href}"><code>${escapeHtml(shortId(row.example.id, 4))}</code></a>` : '—'}</td><td>${escapeHtml(fields)}</td><td class="pb-hidden">${escapeHtml(row.hidden.map(tidy).join(' · '))}</td></tr>`;
    }).join('');
    const caveats = (d.rows || []).filter((r) => r.note).map((r) => `<p class="pb-note">${escapeHtml(r.note.replace(/ \(Tacit docs\/EVM-POOL\.md\)/, ''))}</p>`).join('');
    return {
      html: `<div class="pb">
        <div class="pb-cols"><div><h3 class="pb-h">Public on-chain</h3><ul class="pb-list">${pub}</ul></div><div><h3 class="pb-h">Hidden</h3><ul class="pb-list is-hidden">${hid}</ul></div></div>
        <p class="pb-note">Hidden from the chain, not from the prover: whoever proves a batch sees its amounts.</p>
        ${rows ? `<h3 class="pb-h pb-gap">On real transactions</h3><div class="table-wrap"><table class="table pb-table"><colgroup><col class="c-rec"><col class="c-ex"><col class="c-pub"><col class="c-hid"></colgroup><thead><tr><th scope="col">Record</th><th scope="col">Example</th><th scope="col">Public fields</th><th scope="col">Hidden</th></tr></thead><tbody>${rows}</tbody></table></div>${caveats}` : ''}
        ${(d.notes || []).map((n) => `<p class="empty">${escapeHtml(n)}</p>`).join('')}
        <p class="pb-src">From <a href="${SPEC_URL}" target="_blank" rel="noreferrer">Tacit's protocol spec</a>, section 11 and the sections it points to.</p>
      </div>`,
      asOf: '',
      source: d.sources.filter((s) => !s.startsWith('SPEC')).join(' · '),
    };
  },
};
