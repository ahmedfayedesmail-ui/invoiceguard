// Money Check counters. Aggregate only, anonymous, OFF by default.
// Four events exist. Nothing else can be built or sent. No id, no time, no storage, no cookie.
export const BUCKETS = Object.freeze(['0', '1-29', '30-49', '50-199', '200+']);
export const OUTCOMES = Object.freeze(['all_ready', 'some_held', 'none_ready', 'unreadable']);
// event name -> the only extra keys it may carry
export const EVENTS = Object.freeze({ page_view: [], check_started: [], check_completed: ['bucket', 'outcome'], checkout_click: [] });

/** Size band for the amount found (EUR). Never returns the value itself. */
export function bucketOf(eur) {
  if (typeof eur !== 'number' || !Number.isFinite(eur) || eur < 0) return '0';
  const v = Math.round(eur);
  return v < 1 ? '0' : v < 30 ? '1-29' : v < 50 ? '30-49' : v < 200 ? '50-199' : '200+';
}

/** Coarse outcome flag from an analysis result. Reads only list lengths. */
export function outcomeOf(r) {
  if (!r || r.ok !== true) return 'unreadable';
  const ready = (r.ready || []).length, held = (r.held || []).length;
  return ready && !held ? 'all_ready' : ready ? 'some_held' : 'none_ready';
}

/** Builds the exact payload, or null. Unknown events and unknown values are refused; extra fields are dropped. */
export function buildEvent(name, fields = {}) {
  if (!Object.prototype.hasOwnProperty.call(EVENTS, name)) return null;
  const ev = { v: 1, e: name };
  if (name === 'check_completed') {
    if (!BUCKETS.includes(fields?.bucket) || !OUTCOMES.includes(fields?.outcome)) return null;
    ev.bucket = fields.bucket; ev.outcome = fields.outcome;
  }
  return ev;
}

const post = (url, body) => { try { fetch(url, { method: 'POST', body, keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', headers: { 'content-type': 'text/plain' } }).catch(() => {}); } catch { /* counting must never break the page */ } };

/**
 * mode: 'off' (default) | 'log' (local list only, no network) | 'endpoint' (needs an https endpoint; dormant otherwise).
 * The consent gate covers any measurement beyond the aggregates. It is off and no such measurement exists yet.
 */
export function createCounters(config, io = {}) {
  const c = config && typeof config === 'object' ? config : {};
  const https = typeof c.endpoint === 'string' && /^https:\/\/[^/\s]/.test(c.endpoint);
  const mode = c.mode === 'log' ? 'log' : c.mode === 'endpoint' && https ? 'endpoint' : 'off';
  const send = io.send || post, out = io.log || (() => {});
  const log = [], consent = { extra: false };
  const track = (name, fields) => {
    if (mode === 'off') return false;
    const ev = buildEvent(name, fields); if (!ev) return false;
    if (mode === 'log') { log.push(ev); out(ev); return true; }
    send(c.endpoint, JSON.stringify(ev)); return true;
  };
  const trackExtra = () => false; // no measurement beyond the aggregates exists; the gate stays shut even with consent
  return { mode, log, consent, track, trackExtra };
}
