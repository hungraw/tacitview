// Work that should finish after the response is sent (decoding the rest of a block window, warming the next view).
// On Vercel a function may be frozen once it answers; `waitUntil` from the request context (what @vercel/functions
// wraps, read here without the dependency) keeps it running until the promise settles. Elsewhere it simply runs.
// Vercel stops a function at 20 s (vercel.json maxDuration) and logs a timeout error. So the wait is capped at 16 s
// from this request's first background task: unfinished work is left to the next request (every cache keeps what was
// already fetched) instead of being killed and logged as an error.
const CONTEXT = Symbol.for('@vercel/request-context');
const started = new WeakMap(); // request context -> time of its first background task
const BUDGET_MS = 16_000;

function later(promise) {
  const p = Promise.resolve(promise).catch(() => {});
  try {
    const ctx = globalThis[CONTEXT]?.get?.();
    if (ctx?.waitUntil) {
      if (!started.has(ctx)) started.set(ctx, Date.now());
      const left = Math.max(0, BUDGET_MS - (Date.now() - started.get(ctx)));
      ctx.waitUntil(Promise.race([p, new Promise((resolve) => setTimeout(resolve, left).unref?.())]));
    }
  } catch { /* no request context: the process stays up */ }
  return p;
}

module.exports = { later };
