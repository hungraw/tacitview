// The bridge between the chains: relay tip, SP1-attested height, burns minted. On wide screens (Home, inside the
// ConfidentialPool card) the first two sit on a rail that the Bitcoin tip line runs down (src/connector.js), with the
// burns in transit between them; on narrower screens the card is a plain strip of four figures.
import { number, escapeHtml, shortId, term, doneIcon, waitIcon } from '../format.js';

// Burns in transit by stage (bridge-burns steps): 1 confirming on Bitcoin, 2 waiting for the relay, 3 waiting for SP1,
// 4 attested and waiting for its mint.
const STAGES = [[1, 'confirming'], [2, 'waiting for relay'], [3, 'waiting for SP1']];

export default {
  id: 'bridge',
  sources: ['bridge', 'checks', 'bridgeBurns'],
  optional: ['checks', 'bridgeBurns'],
  render({ bridge: b, checks: c, bridgeBurns: bb }) {
    const tipRow = c?.rows?.find((x) => x.figure === 'Relay tip on Ethereum vs Bitcoin');
    const behind = tipRow && !tipRow.error ? Number(tipRow.diff) : null;
    const pending = Number(b.attestableHeight) - Number(b.attestedHeight);
    const atTip = behind != null && behind <= 2, caughtUp = Number.isFinite(pending) && pending <= 0;
    const burns = bb?.burns || [];
    const count = (step) => burns.filter((x) => x.step === step).length;
    const forMint = count(4);
    const stat = (label, value, note, tone = '', mark = '', dot = '') => `<div class="bstat">${dot}<span>${term(label)}${mark ? ` <i class="mark ${tone}">${mark}</i>` : ''}</span><strong>${value}</strong>${note ? `<em class="${tone}">${note}</em>` : ''}</div>`;
    // Dots on the rail: full when the stage is done (relay at the Bitcoin tip, SP1 caught up), hollow while it is behind.
    const relayDot = `<i class="rail-dot is-relay${atTip ? ' is-full' : ''}" data-rail="relay" aria-hidden="true"></i>`;
    const sp1Dot = `<i class="rail-dot is-sp1${caughtUp ? ' is-full' : ''}" data-rail="sp1" aria-hidden="true"></i>`;
    const chips = STAGES.map(([step, label]) => [count(step), label]).filter(([n]) => n).map(([n, label]) => `<span class="rail-chip"><b>${number(n)}</b>${label}</span>`).join('');
    const relay = stat('Relay tip', number(b.tipHeight), behind == null ? '' : behind > 2 ? `${number(behind)} behind Bitcoin` : 'At Bitcoin tip', behind > 2 ? 'warn' : '', '', relayDot);
    const sp1 = stat('SP1 attested', number(b.attestedHeight), [Number.isFinite(pending) && pending > 0 ? `${number(pending)} pending` : '', forMint ? `${number(forMint)} waiting for mint` : ''].filter(Boolean).join(' · '), caughtUp ? 'ok' : '', Number.isFinite(pending) ? (caughtUp ? doneIcon('Caught up') : waitIcon('Attestation pending')) : '', sp1Dot);
    const minted = stat('Burns minted', `${number(b.bridgeMinted)} of ${number(b.bridgeBurns)}`, b.bridgeBurns == null ? '' : [Number(b.bridgeBurns) - Number(b.bridgeMinted) > 0 ? `${number(Number(b.bridgeBurns) - Number(b.bridgeMinted))} not yet minted` : 'all minted', b.burnsAwaitingBundle ? `${number(b.burnsAwaitingBundle)} awaiting bundle` : ''].filter(Boolean).join(' · '));
    const digest = stat('Reflection digest', `<code class="root">${escapeHtml(shortId(b.chain?.reflectionDigest, 5))}</code>`);
    return {
      html: `<div class="rail-run">${relay}<div class="rail-mid">${chips ? `<div class="rail-chips">${chips}</div>` : ''}<span class="rail-gap" data-rail="gap">24-block gap</span></div>${sp1}</div>${minted}${digest}`,
      asOf: '',
      source: 'BitcoinLightRelay · ConfidentialPool',
    };
  },
};
