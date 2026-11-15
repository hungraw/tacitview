// Security headers for every response. vercel.json carries the same values for production; keep them in sync.
// The only inline code allowed is index.html's stylesheet and early.js, by hash (scripts/modulepreload.mjs writes
// inline-hashes.json and vercel.json together).
const fs = require('node:fs');
const path = require('node:path');
const readInline = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'inline-hashes.json'), 'utf8'));
const csp = (INLINE) => [
  "default-src 'self'",
  `script-src 'self' ${INLINE.script}`,
  `style-src 'self' ${INLINE.style}`,
  "style-src-attr 'unsafe-inline'", // asset marks set a CSS variable via style=""
  "font-src 'self'",
  "img-src 'self' data:",
  // Besides this site, only a node on the visitor's own computer: the block check can read from it (settings).
  "connect-src 'self' http://localhost:* http://127.0.0.1:*",
  "form-action 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const headers = (INLINE) => ({
  'content-security-policy': csp(INLINE),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // No device access, and opted out of the browser's ad-interest APIs (Topics, FLoC).
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=(), interest-cohort=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-dns-prefetch-control': 'off',
});
const SECURITY_HEADERS = headers(readInline());
// The dev server reads the hashes on every request, so regenerating index.html needs no restart.
const securityHeaders = () => headers(readInline());

module.exports = { SECURITY_HEADERS, securityHeaders };
