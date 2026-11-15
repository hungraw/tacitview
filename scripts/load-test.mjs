// Simulates many visitors loading every page source at once, through the real proxy handler, and counts how
// many requests reach each upstream host. With caching and in-flight dedupe this should stay near one request
// per route regardless of the number of visitors. Usage: node scripts/load-test.mjs [visitors]
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const counts = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const u = new URL(String(url));
  const key = `${u.host}${u.host.includes('tacit') ? u.pathname : ''}`;
  counts.set(key, (counts.get(key) || 0) + 1);
  return realFetch(url, options);
};

const { apiHandler } = require('../server/api-handler.cjs');
const { SOURCES } = await import('../src/data/api.js');
const visitors = Number(process.argv[2] || 200);

const get = (path) => new Promise((resolve) => {
  const res = { writeHead(status) { this.status = status; }, end() { resolve(this.status); } };
  apiHandler({ url: `/api${path}`, method: 'GET' }, res);
});

const started = Date.now();
const statuses = await Promise.all(Array.from({ length: visitors }, () => Promise.all(Object.values(SOURCES).map(([path]) => get(path)))));
const flat = statuses.flat();
const total = [...counts.values()].reduce((a, b) => a + b, 0);
console.log(`${visitors} visitors × ${Object.keys(SOURCES).length} sources = ${flat.length} page requests in ${Date.now() - started} ms`);
console.log(`responses: ${[...new Set(flat)].map((s) => `${s}×${flat.filter((x) => x === s).length}`).join(', ')}`);
console.log(`upstream requests: ${total}`);
for (const [host, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${host}`);
