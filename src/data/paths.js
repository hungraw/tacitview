// The API path for a detail or list view, shared by data/api.js and early.js so both ask for exactly the same URL.
export function detailPath(view, id) {
  const param = view === 'footprint' || view === 'names' ? 'q' : 'id';
  const value = String(id || '').trim().slice(0, 512);
  return `/views/${view}?${param}=${encodeURIComponent(value)}`;
}
