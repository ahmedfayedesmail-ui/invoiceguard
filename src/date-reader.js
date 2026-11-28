// The ONE reader for every date Amazon writes in a flat-file report. Pure module: no node imports,
// so the browser bundle can use it. Shared by the issuance gate (integrity-core.js), the
// reconciliation checker (reconcile.js) and the problem-loop projector (loop/project.js).
// Squad swarm/t9-date-reader, owner ruling 2026-11-28: support ALL verified documented date
// formats; NEVER guess an ambiguous date; an ambiguous date comes back with BOTH readings named.
//
// Verified documented shapes (checked 2026-11-28 against Amazon's own pages and sample files):
//  - ISO 8601: YYYY-MM-DD, or an ISO date-time WITH an explicit time zone
//    (declared dates; artifacts the earlier generator wrote). A zone-less time is NOT accepted.
//  - DD/MM/YYYY: the documented example "17/05/2018" on the report-type page:
//    https://developer-docs.amazon/sp-api/docs/report-type-values-invoice-data
//  - M/D/YYYY H:MM: the flat-file sample linked from "Create and upload invoices" writes
//    "2/26/2019 20:14" (month/day/year, unpadded, with a zone-less time):
//    https://developer-docs.amazon/sp-api/docs/create-and-upload-invoices
//
// A slash date whose two numbers leave exactly ONE valid calendar reading is read (that is not a
// guess: the other reading is not a real day). One with two valid readings is AMBIGUOUS and is
// never resolved here: the caller holds it, or resolves it per FILE (a proven order elsewhere in
// the file, or the seller's recorded confirmation), never per value.

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const SLASH = /^(\d{2})\/(\d{2})\/(\d{4})$/; // the documented report form, padded, no time
const SLASH_TIME = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/; // Amazon's published flat-file sample form, unpadded, zone-less time

const validDay = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return m >= 1 && m <= 12 && d >= 1 && d <= 31 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
const iso3 = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Read one raw date cell. Returns ONE of:
 *  { ok: true, kind: 'iso'|'slash', order: 'ISO'|'DAY_FIRST'|'MONTH_FIRST', day: 'YYYY-MM-DD', ms: number|null, hasTime: boolean }
 *    - day is the calendar day the cell carries (for an ISO date-time, the date part as written).
 *    - ms is the exact instant ONLY when the cell proves it: a zoned ISO date-time, or a bare date
 *      (day-granularity: midnight UTC of that day, the same reading Date.parse gives an ISO date).
 *      A zone-less clock time ("2/26/2019 20:14") proves the day but not the instant: ms is null.
 *  { ok: false, kind: 'blank' }
 *  { ok: false, kind: 'ambiguous', dayFirst: 'YYYY-MM-DD', monthFirst: 'YYYY-MM-DD' }  both readings are real days
 *  { ok: false, kind: 'impossible' }   a documented numeric shape with no valid calendar reading
 *  { ok: false, kind: 'unrecognized' } not one of the documented shapes
 */
export function readAmazonDate(v) {
  const t = String(v ?? '').trim();
  if (t === '') return { ok: false, kind: 'blank' };
  const iso = ISO.exec(t);
  if (iso) {
    const [y, mo, d] = [+iso[1], +iso[2], +iso[3]];
    if (!validDay(y, mo, d)) return { ok: false, kind: 'impossible' };
    if (iso[4] !== undefined) { // date-time: the zone is mandatory (the regex requires it), the clock must be real
      const [hh, mm, ss] = [+iso[4], +iso[5], iso[6] === undefined ? 0 : +iso[6]];
      if (hh > 23 || mm > 59 || ss > 59) return { ok: false, kind: 'impossible' };
      const p = Date.parse(t);
      if (Number.isNaN(p)) return { ok: false, kind: 'impossible' };
      return { ok: true, kind: 'iso', order: 'ISO', day: iso3(y, mo, d), ms: p, hasTime: true };
    }
    return { ok: true, kind: 'iso', order: 'ISO', day: iso3(y, mo, d), ms: Date.UTC(y, mo - 1, d), hasTime: false };
  }
  const slt = SLASH_TIME.exec(t), sl = SLASH.exec(t);
  if (sl || slt) {
    const m = slt ?? sl, hasTime = !!slt;
    const a = +m[1], b = +m[2], y = +m[3];
    if (hasTime) { const hh = +m[4], mm = +m[5], ss = m[6] === undefined ? 0 : +m[6]; if (hh > 23 || mm > 59 || ss > 59) return { ok: false, kind: 'impossible' }; }
    const dayFirst = validDay(y, b, a) ? iso3(y, b, a) : null, monthFirst = validDay(y, a, b) ? iso3(y, a, b) : null;
    if (!dayFirst && !monthFirst) return { ok: false, kind: 'impossible' };
    if (dayFirst && monthFirst) return { ok: false, kind: 'ambiguous', dayFirst, monthFirst };
    const day = dayFirst ?? monthFirst, order = dayFirst ? 'DAY_FIRST' : 'MONTH_FIRST';
    return { ok: true, kind: 'slash', order, day, ms: hasTime ? null : Date.UTC(y, +day.slice(5, 7) - 1, +day.slice(8, 10)), hasTime };
  }
  return { ok: false, kind: 'unrecognized' };
}

/** Per-VALUE proof flags, for a caller that resolves the order per FILE (reconcile.js). A value proves
 *  day-first only when its first number is above 12 (so the day-first reading is the only one), and
 *  month-first only when its second number is above 12. An ambiguous value proves nothing. */
export function slashProof(v) {
  const r = readAmazonDate(v);
  const parts = String(v ?? '').trim().split('/');
  return {
    reading: r,
    provesDayFirst: r.ok && r.kind === 'slash' && r.order === 'DAY_FIRST' && +parts[0] > 12,
    provesMonthFirst: r.ok && r.kind === 'slash' && r.order === 'MONTH_FIRST' && +parts[1] > 12,
  };
}
