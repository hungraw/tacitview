// Shrinks every mainnet asset logo to a 96px WebP in server/logos/, plus index.json (id -> file, or null when the asset
// has no logo). The live server serves these files and never runs image code itself.
//
// sharp is not a dependency of the site. Install it for this run only, pinned, then remove it:
//   npm install --no-save sharp@0.34.5 && node scripts/logos.mjs && rm -rf node_modules
//
// Re-run when new assets appear. Existing files are kept (logos are content-addressed on IPFS and never change).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
let sharp;
try { sharp = require('sharp'); } catch { console.error('sharp is not installed: npm install --no-save sharp@0.34.5'); process.exit(1); }
const { fetchOriginal, LOGO_DIR } = require('../server/asset-icon.cjs');
const { getUpstream } = require('../server/upstream.cjs');

const SIZE = 96;
fs.mkdirSync(LOGO_DIR, { recursive: true });
const indexFile = path.join(LOGO_DIR, 'index.json');
const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};

const { data } = await getUpstream('/assets', '?network=mainnet', { ttlMs: 0 });
const ids = (data.assets || []).filter((a) => a.network === 'mainnet').map((a) => a.asset_id).filter((id) => /^[0-9a-f]{64}$/.test(id));
let made = 0, none = 0, failed = 0;
for (const id of ids) {
  if (Object.hasOwn(index, id) && (index[id] === null || fs.existsSync(path.join(LOGO_DIR, index[id])))) continue;
  let icon = null, settled = false;
  for (let attempt = 0; attempt < 4 && !settled; attempt++) { // public gateways rate-limit bursts: slow down and retry
    if (attempt) await new Promise((r) => setTimeout(r, 3000 * attempt));
    ({ icon, settled } = await fetchOriginal(id));
  }
  await new Promise((r) => setTimeout(r, 400));
  if (!settled) { failed++; console.warn(`skip ${id.slice(0, 8)}: no gateway answered`); continue; }
  if (!icon) { index[id] = null; none++; continue; }
  try {
    // SVG is rasterised too, so no script-capable file is ever served.
    const body = await sharp(icon.body, { animated: false, limitInputPixels: 40_000_000 }).resize(SIZE, SIZE, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
    fs.writeFileSync(path.join(LOGO_DIR, `${id}.webp`), body);
    index[id] = `${id}.webp`;
    made++;
  } catch (e) { failed++; console.warn(`skip ${id.slice(0, 8)}: ${e.message}`); }
}
fs.writeFileSync(indexFile, JSON.stringify(Object.fromEntries(Object.entries(index).sort()), null, 1) + '\n');
console.log(`${ids.length} assets: ${made} new logos, ${none} without one, ${failed} skipped; ${Object.values(index).filter(Boolean).length} logos committed`);
