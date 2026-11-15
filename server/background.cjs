// Work that should finish after the response is sent (decoding the rest of a block window, warming the next view).
// On Vercel a function may be frozen once it answers; `waitUntil` from the request context (what @vercel/functions
// wraps, read here without the dependency) keeps it running until the promise settles. Elsewhere it simply runs.
const CONTEXT = Symbol.for('@vercel/request-context');

function later(promise) {
  const p = Promise.resolve(promise).catch(() => {});
  try { globalThis[CONTEXT]?.get?.()?.waitUntil?.(p); } catch { /* no request context: the process stays up */ }
  return p;
}

module.exports = { later };
