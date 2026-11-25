// Real EU VIES VAT validation (free REST API, no key).
const URL_ = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';
const FORMAT = {
  AT: /^ATU\d{8}$/, BE: /^BE[01]\d{9}$/, DE: /^DE\d{9}$/, ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/,
  FR: /^FR[A-Z0-9]{2}\d{9}$/, IE: /^IE\d[A-Z0-9+*]\d{5}[A-Z]{1,2}$/, IT: /^IT\d{11}$/,
  NL: /^NL\d{9}B\d{2}$/, PL: /^PL\d{10}$/, PT: /^PT\d{9}$/, SE: /^SE\d{12}$/,
};
export const normalizeVat = (s) => String(s ?? '').replace(/[\s.\-_]/g, '').toUpperCase();

export function checkFormat(vat) {
  const v = normalizeVat(vat);
  const cc = v.slice(0, 2);
  if (!/^[A-Z]{2}/.test(v)) return { ok: false, reason: 'missing_country_prefix', vat: v };
  if (FORMAT[cc] && !FORMAT[cc].test(v)) return { ok: false, reason: 'bad_format', vat: v, country: cc };
  return { ok: true, vat: v, country: cc };
}

/** status: valid | invalid | unavailable (service error: retry later, never treat as invalid) */
export async function validateVat(vat, { fetchImpl = fetch, retries = 2, timeoutMs = 15000 } = {}) {
  const f = checkFormat(vat);
  if (!f.ok) return { status: 'invalid', ...f };
  const body = JSON.stringify({ countryCode: f.country, vatNumber: f.vat.slice(2) });
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetchImpl(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) });
      const j = await res.json().catch(() => ({}));
      if (res.ok && typeof j.valid === 'boolean') {
        const clean = (x) => (x && x !== '---' ? x : null);
        return { status: j.valid ? 'valid' : 'invalid', reason: j.valid ? null : 'not_registered', vat: f.vat, country: f.country,
          name: clean(j.name), address: clean(j.address), checkedAt: j.requestDate ?? new Date().toISOString() };
      }
      lastErr = j.errorWrappers?.[0]?.error || j.actionSucceed === false && 'service_error' || `http_${res.status}`;
    } catch (e) { lastErr = e.message; }
    await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
  return { status: 'unavailable', reason: String(lastErr), vat: f.vat, country: f.country };
}
