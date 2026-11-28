// API error contract helpers. A message written for the seller (a plain Error thrown on purpose) may be
// shown as it is. Anything that comes from the runtime, the database driver or Amazon's API must not be
// copied into a response: it can name tables, parameters, endpoints or request ids.
export const INTERNAL_MESSAGE = 'Something went wrong on our side. Nothing was changed. Please try again.';
const UPSTREAM = /^(SP-API |LWA token error)/;

/** A bug or driver failure, not a message written for a person (SQLite, bad argument types, Node ERR_* codes). */
export function isInternalError(e) {
  if (!e || typeof e !== 'object') return true;
  if (e.errcode !== undefined || (typeof e.code === 'string' && e.code.startsWith('ERR_'))) return true;
  return e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError || e instanceof URIError;
}
/** A failure reported by Amazon's API client (its message carries the endpoint and Amazon's raw error body). */
export const isUpstreamError = (e) => UPSTREAM.test(String(e?.message ?? ''));

/** Seller-safe text for an Amazon failure: the HTTP status only, never the endpoint or the raw body. */
export function upstreamMessage(e) {
  const code = /-> (\d{3})\b/.exec(String(e?.message ?? ''))?.[1];
  return `Amazon did not accept the request${code ? ` (HTTP ${code})` : ''}. Try again in a few minutes. If it keeps failing, check Seller Central or contact support.`;
}

/** The { status, message } a client may see for an error, plus whether it must be logged as a server fault. */
export function publicError(e, fallbackStatus = 400) {
  if (isUpstreamError(e)) return { status: 502, message: upstreamMessage(e), log: false };
  if (isInternalError(e)) return { status: 500, message: INTERNAL_MESSAGE, log: true };
  return { status: Number.isInteger(e?.status) ? e.status : fallbackStatus, message: String(e?.message ?? '') || INTERNAL_MESSAGE, log: false };
}
