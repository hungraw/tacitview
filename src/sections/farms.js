// Ethereum farm program (FarmManager): epoch, funding and per-pool rates.
import { escapeHtml, fixed, pill, countdown } from '../format.js';

export default {
  id: 'farms',
  sources: ['farms'],
  render({ farms: d }, fetchedAt = {}) {
    const e = d.epoch || {};
    // Runway and epoch end tick down every second from the answer's own clock (countdown in main.js); values that
    // change between refreshes jump (data-roll, sections/index.js).
    // Anchored to when the data was read, so a re-render does not move the end time.
    const at = Math.floor((fetchedAt.farms || Date.now()) / 1000);
    const until = (secs) => (Number.isFinite(Number(secs)) ? `<b class="num" data-until="${at + Number(secs)}">${countdown(Number(secs))}</b>` : '<b class="num">—</b>');
    const roll = (key, v) => `<b class="num" data-roll="${key}">${escapeHtml(v)}</b>`;
    const stats = [
      ['Rate', roll('farm-rate', e.ratePerDayTac != null ? `${fixed(e.ratePerDayTac)} TAC/day` : '—')],
      ['Runway', until(e.fundedRunwaySeconds)], ['Epoch ends', until(e.remainingSeconds)],
      ['Treasury', roll('farm-treasury', e.treasuryTac != null ? `${fixed(e.treasuryTac)} TAC` : '—')],
    ].map(([k, v]) => `<div class="stat"><span>${k}</span>${v}</div>`).join('');
    const rows = (d.pools || []).map((f) => `<div class="row"><span class="row-main"><strong>${escapeHtml(f.pair || 'unknown pair')}</strong><span>${f.sharePct != null ? `${escapeHtml(f.sharePct)}% of rewards` : '—'}${f.idle ? ' · idle' : ''}</span></span><span class="row-end">${roll(`farm-pool-${escapeHtml(String(f.pid))}`, f.tacPerDayForPool != null ? `${fixed(f.tacPerDayForPool)} TAC/day` : '—')}</span></div>`).join('');
    return {
      html: `<div class="stats stats-2">${stats}</div><div class="rows">${rows || '<p class="empty">None right now.</p>'}</div>`,
      status: e.active ? '' : pill('Inactive', 'muted'), // only worth saying when the farm has stopped
      asOf: '',
      source: '/farm/program?network=mainnet',
    };
  },
};
