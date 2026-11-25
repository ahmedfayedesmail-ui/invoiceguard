import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { page } from './site.js';

const dir = fileURLToPath(new URL('./articles/', import.meta.url));

export const ARTICLES = [
  { slug: 'verifactu-amazon-sellers-october-2028', title: 'Verifactu and Amazon sellers: what to do now that the deadline moved to October 2028', desc: 'Verifactu was postponed to 6 October 2028 by Real Decreto-ley 43/2026. What changed, what did not, and a practical plan for Amazon sellers who invoice in Spain.', date: '25 November 2026' },
  { slug: 'amazon-credit-notes-rectificativas', title: 'Amazon credit notes and rectificativas: how corrections actually work for EU sellers', desc: 'Customer returns an order, wants a new billing name, or your invoice had a mistake. Which document do you issue, who issues it, and what Amazon does and does not correct.', date: '25 November 2026' },
  { slug: 'amazon-business-invoice-not-generated', title: 'Amazon Business invoice not generated? What to check and what to do', desc: 'A business customer says there is no VAT invoice for their Amazon order. Why it happens for EU sellers, how to check, and how to fix it within the one-business-day rule.', date: '25 November 2026' },
  { slug: 'pan-eu-vat-number-on-invoice', title: 'Pan-EU selling: which VAT number goes on your Amazon Business invoice?', desc: 'Selling from several EU warehouses? The seller VAT number on a B2B invoice depends on where the goods shipped from, and a local tax ID is not always enough.', date: '25 November 2026' },
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Minimal markdown renderer for the article subset: ## h2, paragraphs, - and 1. lists,
// - [ ] checklists, **bold**, *italic*, [text](url), bare URLs. HTML-escapes first.
function inline(s) {
  const links = [];
  let t = esc(s).replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, txt, url) => { links.push(`<a href="${url}" rel="noopener">${txt}</a>`); return '\x01' + (links.length - 1) + '\x01'; });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  t = t.replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" rel="noopener">$1</a>');
  return t.replace(/\x01(\d+)\x01/g, (_, i) => links[+i]);
}

export function mdToHtml(md) {
  const lines = md.split('\n'); const out = []; let list = null;
  const closeList = () => { if (list) { out.push(list === 'ul' ? '</ul>' : '</ol>'); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trim() === '---') { closeList(); continue; }
    if (line.startsWith('# ')) continue; // the page renders the title itself
    if (line.startsWith('## ')) { closeList(); out.push('<h2>' + inline(line.slice(3)) + '</h2>'); continue; }
    const cb = line.match(/^- \[ \] (.*)$/); const ul = line.match(/^- (.*)$/); const ol = line.match(/^\d+\. (.*)$/);
    if (cb) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push('<li>&#9744; ' + inline(cb[1]) + '</li>'); continue; }
    if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + inline(ul[1]) + '</li>'); continue; }
    if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + inline(ol[1]) + '</li>'); continue; }
    closeList(); out.push('<p>' + inline(line) + '</p>');
  }
  closeList(); return out.join('\n');
}

export function articlesIndex(env = process.env) {
  const cards = ARTICLES.map(a => `<div class="card"><h2 style="font-size:19px"><a href="/articles/${a.slug}">${esc(a.title)}</a></h2><p class="mut">${esc(a.desc)}</p><p class="mut small">${esc(a.date)}</p></div>`).join('\n');
  return page('InvoiceGuard articles', `
<h1>Articles</h1>
<p class="lead">Plain-language notes on Amazon Business invoicing for EU sellers: deadlines, corrections, VAT numbers and what actually goes wrong. General information, not tax or legal advice.</p>
${cards}`, env, 'Plain-language articles on Amazon Business invoicing for EU sellers: Verifactu, credit notes, missing invoices and Pan-EU VAT numbers.');
}

export function articlePage(slug, env = process.env) {
  const a = ARTICLES.find(x => x.slug === slug);
  if (!a) return null;
  let md;
  try { md = readFileSync(dir + slug + '.md', 'utf8'); } catch { return null; }
  return page(a.title + ' - InvoiceGuard', `
<p><a href="/articles">&larr; All articles</a></p>
<h1 style="font-size:27px;line-height:1.3">${esc(a.title)}</h1>
<p class="mut small">${esc(a.date)}</p>
<div style="max-width:46rem">${mdToHtml(md)}</div>
<div class="card" style="margin-top:30px"><h2 style="font-size:18px">See InvoiceGuard on made-up orders</h2><p>No account needed. The live sample builds and checks invoices the same way the app does.</p><p><a class="btn" href="/sample">Watch it work</a></p></div>`, env, a.desc);
}
