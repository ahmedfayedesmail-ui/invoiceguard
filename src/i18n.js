// Server side of the i18n layer: language negotiation per request and localization of API output.
// English is the default and the stored form. See public/i18n/core.js.
import { negotiateLang, localizer, localizeDeep, localizeLines, t, LANGS, DEFAULT_LANG } from '../public/i18n/core.js';
export { negotiateLang, localizer, localizeDeep, localizeLines, t, LANGS, DEFAULT_LANG };
/** Language of a request: ?lang=, X-Lang header, Accept-Language, then DEFAULT_LANG env (when set to a language we have), else English. */
export function requestLang(req, url, env = process.env) {
  const l = negotiateLang({ query: url?.searchParams?.get('lang'), header: req.headers?.['x-lang'], acceptLanguage: req.headers?.['accept-language'] });
  if (l !== DEFAULT_LANG) return l;
  const q = url?.searchParams?.get('lang'), h = req.headers?.['x-lang']; // an explicit English request is respected
  if (/^en/i.test(String(q ?? h ?? ''))) return 'en';
  return LANGS.includes(env.DEFAULT_LANG) ? env.DEFAULT_LANG : DEFAULT_LANG;
}
