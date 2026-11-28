import { createHash } from 'node:crypto';

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Canonical JSON for financial evidence. Objects are key-sorted; arrays retain order.
 * Only JSON primitives and safe integers are accepted: money must already be integer cents.
 */
export function canonicalize(value, path = '$') {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`Evidence numbers must be safe integers at ${path}.`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(',')}]`;
  if (!plainObject(value)) throw new TypeError(`Evidence contains a non-plain value at ${path}.`);
  const keys = Object.keys(value).sort();
  for (const key of keys) if (value[key] === undefined) throw new TypeError(`Evidence contains undefined at ${path}.${key}.`);
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key], `${path}.${key}`)}`).join(',')}}`;
}

export function sha256Hex(value) {
  const input = typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalize(value);
  return createHash('sha256').update(input).digest('hex');
}
