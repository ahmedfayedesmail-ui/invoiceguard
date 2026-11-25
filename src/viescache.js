// Wraps a VAT validator for production use: caches answers, merges identical in-flight lookups and caps parallel calls to VIES.
// Only definite answers are cached. "unavailable" is never cached, so a VIES outage is retried, never remembered as a verdict.
// The answer keeps VIES's own checkedAt, so the audit trail shows when VIES really answered.
export function cachedValidator(validate, { validTtlMs = 6 * 3600e3, invalidTtlMs = 10 * 60e3, maxParallel = Number(process.env.VIES_PARALLEL ?? 6), maxEntries = 20000, now = Date.now } = {}) {
  const cache = new Map(), inflight = new Map(), waiting = []; let running = 0;
  const slot = () => running < maxParallel ? (running++, Promise.resolve()) : new Promise(r => waiting.push(r));
  const release = () => { const n = waiting.shift(); if (n) n(); else running--; };
  const fn = async (vat) => {
    const key = String(vat ?? '').replace(/[\s.\-_]/g, '').toUpperCase(), hit = cache.get(key);
    if (hit && hit.until > now()) { cache.delete(key); cache.set(key, hit); return { ...hit.value, cached: true }; }
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      await slot();
      try {
        const v = await validate(vat);
        const ttl = v.status === 'valid' ? validTtlMs : v.status === 'invalid' && v.reason === 'not_registered' ? invalidTtlMs : 0;
        if (ttl) { cache.set(key, { value: v, until: now() + ttl }); if (cache.size > maxEntries) cache.delete(cache.keys().next().value); }
        return v;
      } finally { release(); }
    })().finally(() => inflight.delete(key));
    inflight.set(key, p); return p;
  };
  const norm = (vat) => String(vat ?? '').replace(/[\s.\-_]/g, '').toUpperCase();
  fn.forget = (vat) => { cache.delete(norm(vat)); };
  fn.fresh = (vat) => { fn.forget(vat); return fn(vat); }; // explicit re-check by the user: never answered from the cache
  fn.stats = () => ({ entries: cache.size, inflight: inflight.size, running, queued: waiting.length });
  fn.clear = () => cache.clear();
  return fn;
}
