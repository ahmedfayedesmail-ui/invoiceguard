// i18n core, shared by the server (src/*.js), the browser app (public/index.html) and the local engine bundle.
// No dependencies. The catalog is two files with identical key sets: public/i18n/en.js and public/i18n/es.js (generated from tools/i18n/*.pairs by tools/gen-i18n.mjs).
// English stays the source language of the code: reasons and errors are produced in English and stored in English.
// A localizer maps an English string (exact text, or a template with {1} {2} placeholders) to the catalog key and renders the target language.
import en from './en.js';
import es from './es.js';

export const CATALOGS = { en, es };
export const LANGS = Object.keys(CATALOGS);
export const DEFAULT_LANG = 'en';
const norm = (l) => { const x = String(l ?? '').trim().toLowerCase().split(/[-_]/)[0]; return LANGS.includes(x) ? x : null; };

/** Language negotiation. Order: explicit `lang` query value, explicit X-Lang header, then the first language in Accept-Language that we have. Anything else: English. */
export function negotiateLang({ query, header, acceptLanguage } = {}) {
  const q = norm(query); if (q) return q;
  const h = norm(header); if (h) return h;
  for (const part of String(acceptLanguage ?? '').split(',')) { const l = norm(part.split(';')[0]); if (l) return l; if (part.trim()) break; }
  return DEFAULT_LANG;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compiled = new Map();
function build(lang, scope) {
  const en_ = CATALOGS.en, tgt = CATALOGS[lang]; const exact = new Map(), pats = [];
  for (const [k, tpl] of Object.entries(en_)) {
    if (scope && !k.startsWith(scope + '.')) continue;
    if (!/\{\d+\}/.test(tpl)) { exact.set(tpl, k); continue; }
    const order = []; const src = tpl.split(/(\{\d+\})/).map((p) => { const m = /^\{(\d+)\}$/.exec(p); if (m) { order.push(Number(m[1])); return '([\\s\\S]+?)'; } return esc(p); }).join('');
    pats.push({ k, re: new RegExp('^' + src + '$'), order, weight: tpl.replace(/\{\d+\}/g, '').length });
  }
  pats.sort((a, b) => b.weight - a.weight);
  return { exact, pats, tgt };
}
const render = (tpl, params) => tpl.replace(/\{(\d+)\}/g, (m, n) => params[n] ?? m);

/** Returns a function (englishText) => text in `lang`. Unknown text is returned unchanged (never guessed). */
export function localizer(lang, scope = null) {
  const l = norm(lang) ?? DEFAULT_LANG; if (l === 'en') { const id = (s) => s; id.covered = () => true; return id; }
  const ck = l + '|' + (scope ?? ''); if (!compiled.has(ck)) compiled.set(ck, build(l, scope));
  const { exact, pats, tgt } = compiled.get(ck);
  const one = (s) => {
    if (typeof s !== 'string' || !s) return null;
    const k = exact.get(s); if (k) return tgt[k];
    for (const p of pats) { const m = p.re.exec(s); if (!m) continue; if (m.slice(1).some((x) => /[.!?]\s+[A-Z]/.test(x))) continue; /* a placeholder never spans a sentence: that is the sentence-wise path */ const params = {}; p.order.forEach((n, i) => { params[n] = tr(m[i + 1])[0]; }); return render(tgt[p.k], params); }
    return null;
  };
  // tr: [text, covered]. covered is true only when the whole text was found in the catalog (whole, sentence by sentence, or a catalogued "Label: rest" prefix).
  const tr = (s) => {
    if (typeof s !== 'string' || !s.trim()) return [s, true];
    if (s !== s.trim()) { const [x, c] = tr(s.trim()); return [s.slice(0, s.length - s.trimStart().length) + x + s.slice(s.trimEnd().length), c]; }
    const whole = one(s); if (whole != null) return [whole, true];
    const parts = s.trim().split(/(?<=[.!?])\s+/);
    if (parts.length > 1) { let ok = true; const out = parts.map((p) => { const t = one(p); if (t != null) return t; const [x, c] = tr1(p); if (!c) ok = false; return x; }); return [out.join(' '), ok]; }
    return tr1(s);
  };
  const tr1 = (s) => {
    const whole = one(s); if (whole != null) return [whole, true];
    const m = /^([^:]{3,60}:)\s+([\s\S]+)$/.exec(s); if (m) { const h = one(m[1]); if (h != null) { const [r, c] = tr(m[2]); return [h + ' ' + r, c]; } }
    return [s, false];
  };
  const loc = (s) => tr(s)[0]; loc.covered = (s) => tr(s)[1];
  return loc;
}

/** Deep-localize every string in a JSON-like value (used on API responses). Only strings that match the catalog change. Scope 'msg' = server messages only: UI labels are never applied to API data, because a value such as a document type may be read by the client as a code. */
export function localizeDeep(v, lang, scope = 'msg') {
  const loc = localizer(lang, scope); if (lang === 'en') return v;
  const walk = (x) => typeof x === 'string' ? loc(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x;
  return walk(v);
}

/** Localize a multi-line text file line by line (pack instructions, README). */
export function localizeLines(text, lang) { const loc = localizer(lang, 'msg'); return String(text).split('\n').map((l) => (l.trim() ? loc(l) : l)).join('\n'); }

/** t('key', {1: a, 2: b}, 'es'): direct lookup by key, English fallback. */
export function t(key, params = {}, lang = DEFAULT_LANG) { const c = CATALOGS[norm(lang) ?? DEFAULT_LANG]; return render(c[key] ?? CATALOGS.en[key] ?? key, params); }
export const catalogKeys = (lang) => Object.keys(CATALOGS[lang]);
