const memory = new Map();
const pending = new Map();
const STORAGE_PREFIX = 'tacit-explorer:data:';

// persist: keep in localStorage so a reload starts from it (the live page sources). One-off lookups (detail pages,
// search, prefetch) stay in memory only, so storage never grows with browsing.
// The last saved answer for a key if it is younger than maxAgeMs, without fetching: for drawing a page at once from
// what this browser already has, then refreshing it.
export function peek(key, maxAgeMs, persist = true) {
  const e = memory.get(key) || (persist ? readStored(key) : null);
  return e && Date.now() - e.savedAt < maxAgeMs && !e.data?.partial ? e : null;
}

export async function cachedJson(key, loader, { ttlMs = 10_000, staleMs = 5 * 60_000, persist = true } = {}) {
  const now = Date.now();
  const cached = memory.get(key) || (persist ? readStored(key) : null);
  if (cached && now - cached.savedAt < ttlMs) return { data: cached.data, stale: false, savedAt: cached.savedAt };
  if (pending.has(key)) return pending.get(key);
  if (typeof navigator !== 'undefined' && navigator.onLine === false && cached && now - cached.savedAt < staleMs) {
    return { data: cached.data, stale: true, savedAt: cached.savedAt };
  }

  const request = (async () => {
    try {
      const data = await loader();
      // Partial answers (the server was still loading part of it) are asked for again within a few seconds and never stored.
      const entry = { data, savedAt: data?.partial ? Date.now() - ttlMs + 4_000 : Date.now() };
      memory.set(key, entry);
      if (persist && !data?.partial) writeStored(key, entry);
      return { data, stale: false, savedAt: entry.savedAt };
    } catch (error) {
      if (cached && Date.now() - cached.savedAt < staleMs) return { data: cached.data, stale: true, error, savedAt: cached.savedAt };
      throw error;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, request);
  return request;
}

function readStored(key) {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_PREFIX + key));
    if (value && Number.isFinite(value.savedAt) && value.data !== undefined) {
      memory.set(key, value);
      return value;
    }
  } catch { /* storage is optional */ }
  return null;
}

function writeStored(key, value) {
  try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value)); } catch { /* storage is optional */ }
}

// Lookups stored by earlier versions (detail pages, search) are removed once, so they stop using the quota.
try {
  for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k?.startsWith(STORAGE_PREFIX + 'detail:') || k?.startsWith(STORAGE_PREFIX + 'footprint:')) localStorage.removeItem(k); }
} catch { /* storage is optional */ }
