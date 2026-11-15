// Bitcoin chain reads from public Esplora hosts (mempool.space, blockstream.info), independent of the Tacit API.
const { cached, spend } = require('./upstream.cjs');

const MEMPOOL_TIP = 'Esplora /blocks/tip/height (mempool.space, blockstream.info, emzy, bitaroo)';

async function mempoolTip() {
  return (await cached('btc:tip', async () => {
    const n = Number(String(await esplora('/blocks/tip/height', 'text')).trim());
    if (!Number.isInteger(n)) throw new Error('Esplora returned a non-integer height');
    return n;
  }, { ttlMs: 15_000 })).data;
}

// Four independent operators of the same Esplora API: spread load, fall back on 429 or outage.
// TACITVIEW_ESPLORA (your own Esplora or mempool instance, e.g. http://127.0.0.1:3002/api) replaces the public hosts.
const ESPLORA_HOSTS = process.env.TACITVIEW_ESPLORA ? [process.env.TACITVIEW_ESPLORA.replace(/\/$/, '')] : ['https://mempool.space/api', 'https://blockstream.info/api', 'https://mempool.emzy.de/api', 'https://mempool.bitaroo.net/api'];

// A raw block is ~1.6 MB: they share one budget per instance so a sweep of heights cannot become a download storm.
// Timeouts are short so four hosts fit inside a view's deadline (views.cjs).
async function esplora(path, kind = 'json', hostIndex = 0) {
  if (kind === 'raw') spend('raw Bitcoin block', 90);
  let lastError;
  for (let attempt = 0; attempt < ESPLORA_HOSTS.length; attempt++) {
    const host = ESPLORA_HOSTS[(hostIndex + attempt) % ESPLORA_HOSTS.length];
    try {
      const r = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(kind === 'raw' ? 8_000 : 4_000) });
      if (!r.ok) throw Object.assign(new Error(`${new URL(host).host} ${path.split('/').slice(0, 3).join('/')} HTTP ${r.status}`), { status: r.status });
      return kind === 'json' ? await r.json() : kind === 'text' ? await r.text() : Buffer.from(await r.arrayBuffer());
    } catch (error) {
      if (error.status === 404 || error.status === 400) throw error; // the chain says it does not exist; another host will agree
      lastError = error;
    }
  }
  throw lastError;
}


module.exports = { esplora, mempoolTip, ESPLORA_HOSTS, MEMPOOL_TIP };
