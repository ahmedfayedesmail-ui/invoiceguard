// Finds user-facing string literals in src/*.js (candidates for the catalog). Template literals: ${expr} becomes {n}. Used by tools/gen-i18n.mjs --scan and by test/i18n.test.js.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SQL = /\b(SELECT|INSERT INTO|UPDATE \w+ SET|DELETE FROM|CREATE (TABLE|INDEX|UNIQUE)|ALTER TABLE|PRAGMA|CREATE TRIGGER|WHERE \w+=)/;
export const SKIP_FILES = new Set(['landing-i18n.js', 'site.js', 'articles.js', 'i18n.js', 'lang.js', 'sample.js', 'pdf.js']); // landing/articles are already native copy per language; lang.js/pdf.js are invoice label tables
/** Tokenizer that understands '..', "..", `..${nested}..`, // and block comments, and regex literals (loosely). */
export function literals(src) {
  const out = []; let i = 0; const n = src.length;
  const readTpl = (start) => { // returns [text with {n}, end]
    let j = start + 1, txt = '', k = 0;
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\') { txt += src[j + 1] === 'n' ? '\n' : src[j + 1]; j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') { let d = 1; j += 2; while (j < n && d) { const c = src[j]; if (c === '`') { j = readTpl(j)[1] + 1; continue; } if (c === "'" || c === '"') { const q = c; j++; while (j < n && src[j] !== q) { if (src[j] === '\\') j++; j++; } j++; continue; } if (c === '{') d++; else if (c === '}') d--; j++; } txt += `{${++k}}`; continue; }
      txt += src[j++];
    }
    return [txt, j];
  };
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i += 2; continue; }
    if (c === "'" || c === '"') { let j = i + 1, t = ''; while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') { t += src[j + 1] === 'n' ? '\n' : src[j + 1]; j += 2; continue; } t += src[j++]; } out.push({ t, pre: src.slice(Math.max(0, i - 40), i) }); i = j + 1; continue; }
    if (c === '`') { const [t, j] = readTpl(i); out.push({ t, pre: src.slice(Math.max(0, i - 40), i) }); i = j + 1; continue; }
    if (c === '/' && /[=(,:;!&|?{}\[]\s*$/.test(src.slice(Math.max(0, i - 3), i))) { let j = i + 1; while (j < n && src[j] !== '/' && src[j] !== '\n') { if (src[j] === '\\') j++; if (src[j] === '[') { while (j < n && src[j] !== ']') { if (src[j] === '\\') j++; j++; } } j++; } i = j + 1; continue; }
    i++;
  }
  return out;
}
export const isMessage = (s) => { const w = s.trim().split(/\s+/); return w.length >= 3 && /[A-Za-z]{3,}/.test(s) && /^[A-Za-z"'(]/.test(s.trim()) && !SQL.test(s) && !/^[a-z_]+(\s[a-z_]+)*$/.test(s) && !/^(https?:|\/|\.)/.test(s) && !/[<>]{1}\w+[^<>]*>/.test(s.slice(0, 40)) && !/^[\w$.\-/{}]+( [\w$.\-/{}=<>!&|?:]+){2,}$/.test(s) ; };
/** Short strings are messages when they sit right after error:/reason:/explanation:/action: or new Error(. Single lowercase words are codes, not messages. */
export const isCtxMessage = (s, pre) => /(\berror|\breason|\bexplanation|\baction|\bdefer|\bnote)\s*[:=]\s*$|new Error\(\s*$/.test(pre) && /[A-Za-z]{3,}/.test(s) && !/^[a-z_]+$/.test(s) && !SQL.test(s);
export function scan() {
  const res = []; const dir = join(root, 'src');
  for (const f of readdirSync(dir).filter(x => x.endsWith('.js') && !SKIP_FILES.has(x))) for (const { t: s, pre } of literals(readFileSync(join(dir, f), 'utf8'))) if (isMessage(s) || isCtxMessage(s, pre)) res.push({ file: f, text: s });
  return res;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { const seen = new Set(); for (const r of scan()) { const k = r.text; if (seen.has(k)) continue; seen.add(k); console.log(r.file + '\t' + JSON.stringify(r.text)); } }
