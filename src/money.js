// Money rounding, one rule for the whole tool: round HALF AWAY FROM ZERO on the DECIMAL value of the
// amount, so a stored amount is the cent any two-decimal display of it shows.
//
// Why not Math.round(n * 100) / 100: that rounds the BINARY value, which is not a rounding rule at
// all. 4.515 is stored as 4.5149999999999997, so 4.515 * 100 is 451.49999999999994 and rounds DOWN
// to 4.51, although both standard decimal rules (half up, half even) give 4.52. A computed VAT or
// base therefore lands one cent BELOW the value for some amounts and not others: 21.50 at 21% stored
// 4.51, and 159 of 2000 half-euro bases at 21% (162 at 9%, 37 at 19%) were a cent low, while the same
// arithmetic at 0.035 gave 0.04. Number.EPSILON does not repair it: it is smaller than one ulp above
// about 0.03, so it only shifts the smallest values.
//
// The rule here reads the shortest round-trip decimal (String(n), what a display and JSON.stringify
// see), shifts it two places with decimal arithmetic, and rounds half up. Values that print in
// exponential notation are outside any money range this tool issues and keep plain arithmetic.

/** Integer cents of an amount, rounded half away from zero on its decimal value. */
export function toCents(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return x;
  const s = Math.abs(x).toString();
  if (s.includes('e') || s.includes('E')) return Math.round(x * 100);
  const [i, f = ''] = s.split('.');
  const frac = (f + '000').slice(0, 3);
  let c = Number(i) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) c += 1;
  return x < 0 ? -c : c;
}

/** An amount rounded to cents with the same rule, so r2(n) and every printed form of n agree. */
export const r2 = (n) => { const c = toCents(n); return Number.isFinite(c) ? c / 100 : c; };

/** True when the amount is already a whole number of cents (at most two decimals). */
export const isWholeCents = (n) => { const x = Number(n); return Number.isFinite(x) && Math.abs(x - toCents(x) / 100) <= 1e-9; };
