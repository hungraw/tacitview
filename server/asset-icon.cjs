// Asset logos. Each Tacit asset carries an image_uri (ipfs://<cid>) in the Tacit API's asset index: either the
// image itself or a metadata JSON whose "image" field points at it (many assets have no image). We fetch it
// server-side from public IPFS gateways and serve it same-origin, so a visitor's browser never contacts a gateway
// (no third-party requests, and the page CSP stays img-src 'self'). Only ids from the asset index are accepted,
// so this cannot be pointed at arbitrary URLs.

const fs = require('node:fs');
const path = require('node:path');
const { getUpstream } = require('./upstream.cjs');

const GATEWAYS = ['https://ipfs.filebase.io/ipfs/', 'https://dweb.link/ipfs/', 'https://ipfs.io/ipfs/'];
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif']);
const MAX_BYTES = 3 * 1024 * 1024; // what scripts/logos.mjs will download
const LIVE_MAX = 48 * 1024; // what the server will pass through for an asset with no committed logo yet
// "This asset has no logo": a 1x1 transparent GIF rather than a 404, so the page's letter badge shows through and
// the browser logs no error for an expected case.
const NONE = { type: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), none: true };
const cache = new Map(); // id -> { type, body } | null (no usable image); content-addressed, so it never goes stale
const CACHE_MAX = 300;

const cidOf = (uri) => { const m = /^ipfs:\/\/(?:ipfs\/)?([a-zA-Z0-9]{20,100})(\/[\w.-]*)?$/.exec(String(uri || '')); return m ? m[1] + (m[2] || '') : null; };
async function imageUri(id) {
  const { data } = await getUpstream('/assets', '?network=mainnet', { ttlMs: 60_000 });
  return cidOf((data.assets || []).find((a) => a.asset_id === id)?.image_uri);
}

async function fetchFrom(gateway, cid, depth = 0) {
  const res = await fetch(gateway + cid, { signal: AbortSignal.timeout(6000), redirect: 'follow' });
  if (!res.ok) throw new Error(`gateway ${res.status}`);
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json' && depth === 0) { // metadata: follow its "image" (ipfs only), once
    const meta = JSON.parse(Buffer.from(await res.arrayBuffer()).subarray(0, 64 * 1024).toString());
    const next = cidOf(meta?.image);
    if (!next) return null;
    return fetchFrom(gateway, next, 1);
  }
  if (!TYPES.has(type)) throw new Error(`not an image: ${type}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_BYTES) throw new Error('image too large');
  return { type, body };
}

// The original image for an asset, straight from IPFS (or null when it has none). scripts/logos.mjs uses this.
async function fetchOriginal(id) {
  const cid = await imageUri(id);
  if (!cid) return { icon: null, settled: true };
  for (const g of GATEWAYS) { try { return { icon: await fetchFrom(g, cid), settled: true }; } catch { /* next gateway */ } }
  return { icon: null, settled: false };
}

// Logos are shrunk ahead of time by scripts/logos.mjs (run by hand, with sharp installed only for that run) and committed
// in server/logos/, so the live server runs no image code and no third-party package. index.json lists every asset
// the script saw: a file name, or null for "has no logo".
const LOGO_DIR = path.join(__dirname, 'logos');
let manifest = null;
const committed = () => { if (!manifest) { try { manifest = JSON.parse(fs.readFileSync(path.join(LOGO_DIR, 'index.json'), 'utf8')); } catch { manifest = {}; } } return manifest; };

async function assetIcon(id) {
  if (!/^[0-9a-f]{64}$/.test(id || '')) return null;
  if (cache.has(id)) return cache.get(id);
  const m = committed();
  if (Object.hasOwn(m, id)) {
    const icon = m[id] ? { type: 'image/webp', body: fs.readFileSync(path.join(LOGO_DIR, path.basename(m[id]))) } : NONE;
    cache.set(id, icon);
    return icon;
  }
  // An asset newer than the committed set: pass a small original through; a large one shows the letter badge
  // until the script is run again.
  let { icon, settled } = await fetchOriginal(id);
  if (icon && icon.body.length > LIVE_MAX) icon = { ...NONE, untilRerun: true };
  if (!icon && settled) icon = NONE;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  if (settled) cache.set(id, icon); // an answer (image or "has none") is final; gateway failures are retried
  return icon;
}

function iconHandler(req, res, id) {
  assetIcon(String(id || '').toLowerCase()).then((icon) => {
    if (!icon) { res.writeHead(404, { 'cache-control': 'public, max-age=300' }); return res.end(); }
    res.writeHead(200, {
      'content-type': icon.type,
      // A real logo never changes (content-addressed). "No logo" may change when logos.mjs runs again.
      'cache-control': icon.none ? 'public, max-age=3600, s-maxage=3600' : 'public, max-age=86400, s-maxage=604800, immutable',
      // SVG logos never run scripts: served as images with a locked-down policy.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : icon.body);
  }).catch(() => { res.writeHead(502, { 'cache-control': 'no-store' }); res.end(); });
}

module.exports = { assetIcon, iconHandler, fetchOriginal, LOGO_DIR };
