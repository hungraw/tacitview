// Upstream routes the browser may fetch through /api (GET only, enforced in api-handler.cjs), each with
// its shared-cache lifetime in seconds. Views (server/views.cjs) fetch their own upstreams server-side
// and are not listed here. Add a route only when page code calls it.

const ROUTES = new Map([
  ['/reflection/status', 10],
  ['/reflection/proof', 30],
  ['/confidential/relay', 10],
  ['/prover-health', 15],
  ['/prover/board', 15],
  ['/prover/pool/recent', 15],
  ['/recent', 10],
  ['/assets', 60],
  ['/amm/pools', 30],
  ['/farm/program', 60],
]);

const routeTtl = (path) => (typeof path === 'string' && ROUTES.has(path) ? ROUTES.get(path) : null);

module.exports = { routeTtl, ROUTES };
