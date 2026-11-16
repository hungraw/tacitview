// Vercel serverless entry. vercel.json rewrites /api/:path* to /api/proxy?path=:path* (the documented
// pattern for projects without a framework); this restores the original /api/<path>?<query> URL.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { apiHandler } = require('../server/api-handler.cjs');
const { warm } = require('../server/views.cjs');
const { later } = require('../server/background.cjs');
let warmed = false; // decode recent Bitcoin blocks on this instance's first request, inside its waitUntil

export function originalUrl(url) {
  const parsed = new URL(url, 'http://localhost');
  if (parsed.pathname !== '/api/proxy') return url; // called directly as /api/<path>
  const path = parsed.searchParams.get('path') || '';
  parsed.searchParams.delete('path');
  const query = parsed.searchParams.toString();
  return `/api/${path}${query ? `?${query}` : ''}`;
}

export default function handler(req, res) {
  req.url = originalUrl(req.url);
  // Not for a single decoded block: instances ask that route for each block, and warming there would start the
  // whole home page again on every instance it spins up.
  if (!warmed && !req.url.startsWith('/api/views/btc-block-decoded')) { warmed = true; later(warm()); }
  apiHandler(req, res);
}
