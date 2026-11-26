// Public pages: landing, privacy, contact. Plain HTML, no scripts, no cookies, no third-party requests.
// Operator details come from the environment so nothing is invented: OPERATOR_NAME, CONTACT_EMAIL, OPERATOR_COUNTRY.
export const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UPDATED = '25 November 2026';
export const CSS = `:root{--ink:#14202b;--mut:#5d6b78;--line:#e4e9ee;--bg:#f5f7f9;--pri:#0f766e;--priD:#0b5a54}*{box-sizing:border-box}body{margin:0;font:16px/1.65 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{background:#fff;border-bottom:1px solid var(--line);padding:14px 20px;display:flex;align-items:center;gap:18px;flex-wrap:wrap}.logo{font-weight:700;font-size:19px;letter-spacing:-.02em;color:var(--ink);text-decoration:none}.logo b{color:var(--pri)}.sp{flex:1}
nav a{color:var(--mut);text-decoration:none;margin-left:16px;font-size:15px}nav a:hover{color:var(--ink)}
.btn{display:inline-block;background:var(--pri);color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600}.btn:hover{background:var(--priD)}.btn.alt{background:#fff;color:var(--pri);border:1px solid var(--pri)}
main{max-width:860px;margin:0 auto;padding:28px 20px 60px}main a{color:var(--priD);overflow-wrap:anywhere}.hero{padding:34px 0 12px}h1{font-size:clamp(28px,5vw,40px);line-height:1.15;margin:0 0 14px;letter-spacing:-.02em}h2{font-size:22px;margin:34px 0 8px}h3{font-size:17px;margin:20px 0 4px}
p{margin:0 0 12px}.lead{font-size:19px;color:#2d3b47}.mut{color:var(--mut)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin:16px 0}.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px}.card h3{margin-top:0}
.note{background:#fff8e6;border:1px solid #f3dca0;border-radius:10px;padding:12px 16px;font-size:15px;margin:18px 0}ul{padding-left:22px;margin:0 0 12px}li{margin:4px 0}
footer{border-top:1px solid var(--line);background:#fff;padding:20px;text-align:center;color:var(--mut);font-size:14px}footer a{color:var(--mut);margin:0 10px}table{border-collapse:collapse;width:100%;font-size:15px;background:#fff}td,th{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}th{background:#f0f3f6}
@media(max-width:560px){nav a{margin-left:10px}}`;
const cfg = (env) => ({ name: String(env.OPERATOR_NAME ?? '').trim(), email: String(env.CONTACT_EMAIL ?? '').trim(), country: String(env.OPERATOR_COUNTRY ?? '').trim() });
export const LANDING_LOCALES = [['en', '/'], ['es', '/es'], ['de', '/de'], ['fr', '/fr'], ['it', '/it'], ['nl', '/nl'], ['pl', '/pl']];
export const hreflangHead = (host, selfPath) => !host ? '' : `<link rel="canonical" href="https://${host}${selfPath}">` + LANDING_LOCALES.map(([hl, p]) => `<link rel="alternate" hreflang="${hl}" href="https://${host}${p}">`).join('') + `<link rel="alternate" hreflang="x-default" href="https://${host}/">`;

export const page = (title, body, env, desc, headExtra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${headExtra}<title>${esc(title)}</title><meta name="description" content="${esc(desc ?? 'InvoiceGuard helps Amazon sellers issue and check B2B invoices.')}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc ?? 'InvoiceGuard helps Amazon sellers issue and check B2B invoices.')}"><meta property="og:type" content="website"><meta name="twitter:card" content="summary"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><style>${CSS}</style></head><body>
<header><a class="logo" href="/">Invoice<b>Guard</b></a><span class="sp"></span><nav><a href="/sample">Live sample</a><a href="/#how">How it works</a><a href="/faq">FAQ</a><a href="/articles">Articles</a><a href="/privacy">Privacy</a><a href="/contact">Contact</a></nav><a class="btn" href="/app">Open the app</a></header>
<main>${body}</main>
<footer><a href="/">Home</a><a href="/faq">FAQ</a><a href="/articles">Articles</a><a href="/privacy">Privacy</a><a href="/contact">Contact</a><div style="margin-top:8px">InvoiceGuard is a pilot-stage tool. It is not tax or legal advice.</div><div style="margin-top:6px;font-size:13px"><b>EN</b> · <a href="/es">ES</a> · <a href="/de">DE</a> · <a href="/fr">FR</a> · <a href="/it">IT</a> · <a href="/nl">NL</a> · <a href="/pl">PL</a></div></footer></body></html>`;
const who = (c) => c.name ? esc(c.name) : 'the InvoiceGuard operator';
const contactLine = (c) => c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : 'the form on the <a href="/contact">contact page</a>';

// Country-aware landing copy: the visitor's market (guessed from the browser language) decides which
// local rule and which familiar pains we name. Spain stays the default market of the pilot.
const MARKET_COPY = {
  ES: { name: 'Spain', rule: 'Spain: Amazon\'s one-business-day invoice deadline applies, and Verifactu reporting is on the way.', familiar: ['Amazon\'s own invoicing is switched on, yet the invoices never arrive, so you keep making them by hand.', 'One Pan-EU order shows your Spanish CIF, the next a German VAT number, and it is never clear which one belongs on the invoice.', 'Verifactu is on the way in Spain, and nobody can say plainly which of your invoices it covers.'] },
  DE: { name: 'Germany', rule: 'Germany: \u00a714 UStG sets what must be on every invoice, and Amazon wants the upload within one business day.', familiar: ['Amazon\'s own invoicing is switched on, yet the invoices never arrive, so you keep making them by hand.', 'One Pan-EU order goes out with one of your VAT numbers, the next with another, and it is never clear which one belongs on the invoice.', 'A single missing detail under \u00a714 UStG can cost your buyer their input VAT deduction - and you the buyer.'] },
  FR: { name: 'France', rule: 'France: B2B e-invoicing becomes mandatory in stages from 2026, and Amazon wants the upload within one business day.', familiar: ['Amazon\'s own invoicing is switched on, yet the invoices never arrive, so you keep making them by hand.', 'One Pan-EU order goes out with one of your VAT numbers, the next with another, and it is never clear which one belongs on the invoice.', 'France\'s e-invoicing mandate phases in from 2026, and nobody can say plainly which of your invoices it covers.'] },
  IT: { name: 'Italy', rule: 'Italy: e-invoicing through the SDI system already applies, and Amazon wants the upload within one business day.', familiar: ['Amazon\'s own invoicing is switched on, yet the invoices never arrive, so you keep making them by hand.', 'One Pan-EU order goes out with one of your VAT numbers, the next with another, and it is never clear which one belongs on the invoice.', 'Italy already runs e-invoicing through SDI, and an invoice that ignores its rules is not an invoice.'] },
};
const EU_COPY = { name: 'the EU', rule: 'Amazon asks for the invoice within one business day of dispatch, and each EU country adds its own invoicing rules on top.', familiar: MARKET_COPY.ES.familiar };

/** Best-effort market guess from the Accept-Language header. Spain (the pilot market) is the fallback. */
export const countryFromLang = (al) => { const m = /\b(nl|pl|de|fr|it|es)\b/i.exec(String(al ?? '')); return m ? m[1].toUpperCase() : 'ES'; };

export function landing(env = process.env, opts = {}) {
  const cta = opts.ctaHref || '/sample';
  const market = MARKET_COPY[opts.country] ?? EU_COPY;
  const guessed = !!MARKET_COPY[opts.country] && opts.country !== 'ES';
  const h1 = opts.variant === 'b' ? 'Your first Amazon Business order comes with a one-business-day invoice deadline.' : 'Amazon Business invoices, without the hand-made part.';
  const lead = opts.variant === 'b' ? 'InvoiceGuard builds and checks the invoice from your Seller Central report, so the deadline is met without the hand-made part. Pilot, free for now.' : 'Amazon says invoicing is automatic. Many sellers still end up making every invoice by hand. InvoiceGuard takes the order report you download from Seller Central, builds an invoice for each business shipment in it (one per order when the report has no shipment IDs), and checks it before anything goes out: the buyer\'s VAT number, the required details, the numbering, the deadline. If something looks wrong, it stops and tells you what to fix, in plain English.';
  return page('InvoiceGuard: B2B invoices for Amazon sellers, checked before they go out', `
<section class="hero"><h1>${h1}</h1>
<p class="lead">${lead}</p>
<p class="mut" style="margin-top:-4px">${esc(market.rule)}${guessed ? ' <span style="font-size:13px">(We guessed your market from your browser language.)</span>' : ''}</p>
<p><a class="btn" href="${cta}">Watch it work: 2 minutes, no account</a> &nbsp; <a class="btn alt" href="/app">Try it yourself: free account</a> &nbsp; <a class="btn alt" href="/contact">Join the free pilot</a></p></section>
<div class="note"><b>Honest status:</b> InvoiceGuard is a pilot. It is not connected to Amazon. Today it runs on made-up sample data only - you cannot upload your own Seller Central report yet, because we have not yet tested on a real one. We open uploads when we have, and this page will say so. Nothing from the sample data is sent to Amazon.</div>
<h2>Sound familiar?</h2><ul>${market.familiar.map(f => '<li>' + esc(f) + '</li>').join('')}</ul>
<p>These are the threads sellers post on Amazon's own forums. They are why InvoiceGuard exists.</p>
<h2>Who it is for</h2><p>Sellers who sell to businesses on Amazon in the EU and want invoices that are complete, numbered in order, and issued on time, without doing it by hand. It is built for small teams, not accountants.</p>
<h2 id="how">How it works</h2>
<div class="grid"><div class="card"><h3>1. You try it on sample orders</h3><p>The pilot account comes with made-up sample orders - the same steps you will follow with your own order report (downloaded from Seller Central) once uploads open. We read the business shipments and skip the rest.</p></div>
<div class="card"><h3>2. It builds and checks the invoice</h3><p>Required details, numbering and deadlines are checked before the invoice is final, and the buyer's VAT number is checked in the EU's VIES service. Selling across the EU? The buyer's country rules are applied as data, each with its source and the date we last verified it.</p></div>
<div class="card"><h3>3. You download the pack</h3><p>You get the PDFs, a list, and short steps for uploading them to Amazon. Anything we are unsure about is held with the reason. We never guess.</p></div></div>
<h2>What you get</h2><ul><li>A simple dashboard: what was invoiced, what is held and why.</li><li>Invoices as PDFs, in the buyer's language where supported, and corrections when an order changes.</li><li>Buyer VAT numbers checked in the EU VIES service when you ask.</li><li>Every invoice carries its own evidence trail: the order detected, the invoice issued, the upload - each with its timestamp, so you can show it went out inside Amazon's window.</li><li>A tamper-evident log of every invoice issued.</li><li>Country rules kept as data. Each rule shows its source, the date we last verified it, and a status: verified, secondary or unverified. A rule we cannot verify blocks issuing instead of being assumed.</li></ul>
<h2>Where it works today</h2><p>Country coverage is per feature, and we say it plainly:</p><ul><li><b>Spain</b>: invoices and corrections, including credit notes (rectificativas by differences) - verified rules.</li><li><b>Germany</b>: invoices - verified rules. Corrections: data corrections (replacement invoice) only; amount corrections and credit notes are held until the German correction rules are verified for them.</li><li><b>France</b>: invoices - verified rules, with some invoices requiring extra details the app asks for. Corrections: data corrections only; credit notes are held. Our French rules are verified until 2026-12-31 and the app holds issuing after that date until they are re-read.</li><li><b>Italy, Netherlands, Poland</b>: on hold. We have not finished verifying their rules, so the app waits rather than guesses.</li></ul>
<h2>What it does not do</h2><ul><li>It does not give tax or legal advice. Confirm your own situation with your adviser.</li><li>It does not file anything with a tax authority.</li><li>Some countries are on hold until we have read the official legal text. The app tells you which.</li><li>The "defect rate" figure in the app is our own estimate, not an Amazon figure.</li></ul>
<h2>Your data</h2><p>We keep only what the service needs, we do not sell it, and we do not use advertising or analytics trackers. Read the <a href="/privacy">privacy page</a> for the details.</p>
<h2 id="pricing">Pricing</h2><p>InvoiceGuard is free during the pilot. We have not set paid plans yet. If we introduce them, the prices will be shown here before anyone is charged, and pilot users will be told first.</p>
<h2>Free pilot</h2><p>We are looking for a few sellers to try InvoiceGuard for free and tell us what is missing. See the <a href="/contact">contact page</a> to get in touch.</p>
<p style="margin-top:26px"><a class="btn" href="/sample">Watch it work: 2 minutes, no account</a> &nbsp; <a class="btn alt" href="/contact">Join the free pilot</a></p>`, env, 'InvoiceGuard builds and checks B2B invoices for Amazon sellers in the EU. Pilot stage, honest about what works today.', hreflangHead(opts.host, '/'));
}

export function privacy(env = process.env) {
  const c = cfg(env);
  return page('InvoiceGuard privacy notice', `
<h1>Privacy notice</h1><p class="mut">Last updated ${UPDATED}. Plain-language summary first, details below.</p>
<div class="note"><b>In short:</b> we store what is needed to run your account and your invoices. We do not sell your data, we show no ads, and we use no analytics or advertising cookies. If you connect Amazon, we use Amazon data only to prepare and check your invoices.</div>
<h2>Who is responsible</h2><p>${who(c)}${c.country ? ', ' + esc(c.country) : ''} runs InvoiceGuard and is responsible for your data. Contact: ${contactLine(c)}.</p>
<h2>What we store</h2>
<table><tr><th>Data</th><th>Why</th></tr>
<tr><td>Your email address and a salted hash of your password (never the password itself)</td><td>To sign you in.</td></tr>
<tr><td>Your business name, tax ID, address, and the marketplaces you sell on</td><td>To put on your invoices and apply the right rules.</td></tr>
<tr><td>The order report the app works on (order number, date, totals, buyer name, buyer country and buyer VAT number)</td><td>To build and check invoices. In the current pilot these are made-up sample data - your own report cannot be uploaded yet.</td></tr>
<tr><td>Invoices we issue for you and a log of what was issued and when</td><td>So you have your records and they cannot be quietly altered.</td></tr>
<tr><td>Your Amazon connection credentials, encrypted (AES-256-GCM) with a key held only on the server</td><td>Only if a direct Amazon connection is switched on, which it is not today.</td></tr>
<tr><td>A security log: time, type of event (sign-in, failed sign-in, password change), your network address, and a short fingerprint of the email, never the password</td><td>To spot and investigate attacks. Kept for 13 months.</td></tr>
<tr><td>Messages you send through the contact form (the text, and the email address only if you give one)</td><td>To answer you. Stored on our own server only, never forwarded, deleted after 180 days.</td></tr>
<tr><td>A sign-in cookie</td><td>To keep you signed in. It is strictly necessary, HttpOnly and Secure. We set no other cookies.</td></tr></table>
<h2>Who else sees data</h2><ul>
<li><b>EU VIES service</b> (European Commission): when a buyer VAT number is checked, the number is sent to VIES to find out whether it is valid.</li>
<li><b>Amazon</b>: nothing is sent to Amazon from this service. You upload your invoices yourself.</li>
<li><b>Our hosting provider</b> (Railway) stores the database and runs the service, in a data centre that may be outside the EU.</li>
<li>We do not sell data, share it for advertising, or give it to anyone else, unless the law requires it.</li></ul>
<h2>Amazon data</h2><p>Data we receive from Amazon is used only to prepare, check and keep your invoices for you. We do not use it for marketing, we do not combine it with other sources, and we do not share it with other sellers.</p>
<h2>How long we keep it</h2><p>Account details are kept while your account is active. Buyer personal data that comes from Amazon is kept only as long as it is needed to issue and keep the invoice, and only as long as Amazon's data protection rules and the tax rules that apply to you allow. Invoices may have to be kept for years under those tax rules. When you ask us to delete your account, we delete its data, or return it to you first, and we tell you if something has to be kept by law.</p>
<h2>Your rights</h2><p>If the EU GDPR applies to you or your buyers, you can ask us to show you your data, correct it, delete it, or hand it over in a usable file, and you can object to how it is used. Contact us through ${contactLine(c)}. We aim to reply within 30 days. You can also complain to your local data protection authority.</p>
<h2>Security</h2><p>Connections use HTTPS. Passwords must be at least 12 characters and are hashed. You can turn on two-step sign-in with an authenticator app. Accounts lock for a while after repeated wrong passwords. Amazon credentials are encrypted. Buyer names and billing addresses are removed from our order records 30 days after shipment. Write requests are checked against cross-site attacks, sign-in attempts are rate limited, and each page sends security headers. No system is perfectly safe; if we ever learn of a breach that affects you, we will tell you.</p>
<h2>Changes</h2><p>If we change this notice in a way that matters, we will update the date above and tell active users.</p>`, env, 'How InvoiceGuard handles your data.');
}

export function notFound(env = process.env) {
  return page('Page not found: InvoiceGuard', `
<section class="hero"><h1>That page does not exist.</h1>
<p class="lead">The link may be old or mistyped. Everything here lives in one of these places:</p>
<p><a class="btn" href="/">Home</a> &nbsp; <a class="btn alt" href="/sample">Live sample</a> &nbsp; <a class="btn alt" href="/faq">FAQ</a> &nbsp; <a class="btn alt" href="/contact">Contact</a></p></section>`, env, 'Page not found.');
}

export function faq(env = process.env) {
  return page('InvoiceGuard: frequently asked questions', `
<h1>Frequently asked questions</h1>
<h2>Does InvoiceGuard upload invoices to Amazon for me?</h2>
<p>No, and it is not connected to Amazon at all. In the current pilot the app runs on made-up sample data only. When uploads open, the flow stays manual: you download the order report from Seller Central and drop it in, and you upload the finished invoice PDFs to Amazon yourself.</p>
<h2>Is InvoiceGuard connected to my Seller Central account?</h2>
<p>No. We never ask for your Amazon login or your Amazon developer credentials. In the current pilot nothing of yours reaches us - the app runs on made-up sample data.</p>
<h2>Which orders does it invoice?</h2>
<p>The business shipments in the report: one invoice per shipment, or one per order when the report has no shipment IDs. Consumer orders are skipped. If a business order has a problem, such as a buyer VAT number that fails the EU check, the invoice is held with the reason and the next step, never guessed.</p>
<h2>What about Verifactu?</h2>
<p>Verifactu concerns invoices that Spanish businesses issue through verifiable invoicing systems. On 25 November 2026 a new law (Real Decreto-ley 43/2026) postponed the deadline: invoicing systems must be adapted before 6 October 2028. Whether it covers your Amazon invoices depends on your own setup, and that is a question for your gestor. InvoiceGuard is not a Verifactu-verifiable system. What it gives you is the invoice documents and a tamper-evident record of what was issued and when, which is the part you keep.</p>
<h2>I sell across the EU. Which VAT number goes on the invoice?</h2>
<p>The invoice shows the seller details from your profile and the buyer's VAT number, checked in the EU's VIES service. If you are registered in more than one EU country, which registration applies to a given sale depends on where the order ships from and your setup, again your gestor's call. The app shows where your shipments left from so that conversation starts from facts.</p>
<h2>Can Amazon or a tax authority reject an invoice it makes?</h2>
<p>We cannot promise acceptance by anyone. Each invoice is built against the country rules we could verify, each rule shows its source and the date we last checked it, and a rule we cannot verify blocks issuing instead of being assumed. That is the honest version of "compliant".</p>
<h2>What does it cost?</h2>
<p>Nothing during the pilot. If paid plans come later, the prices will be shown on the home page before anyone is charged, and pilot users will be told first.</p>
<h2>What happens to my data?</h2>
<p>We keep only what the service needs, we do not sell it, and we use no advertising or analytics trackers. The <a href="/privacy">privacy page</a> has the details in plain language.</p>`, env, 'Straight answers about InvoiceGuard: what it does with your Amazon order report, Verifactu, EU VAT numbers, data, and cost.');
}

export function sample(env = process.env) {
  return page('Live sample: InvoiceGuard checks made-up Amazon orders', `
<section class="hero"><h1>See InvoiceGuard work on made-up Amazon orders.</h1>
<p class="lead">This runs the real checks on sample orders, right now: it builds the invoices and verifies the buyer VAT numbers with the EU service. No account, nothing stored, nothing sent to Amazon. The data is made up.</p>
<p><button class="btn" id="run" type="button">Run the sample</button></p></section>
<div id="out" aria-live="polite"></div>
<style>button.btn{font:inherit;cursor:pointer;border:0}button.btn:disabled{opacity:.6;cursor:default}.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;font-weight:600}.p-held{background:#fde8e8;color:#b91c1c}.p-uploaded{background:#e6f6ec;color:#047857}.err{color:#b91c1c}</style>
<script src="/sample.js"></script>`, env, 'Run InvoiceGuard on made-up Amazon orders and see the checks and the invoice PDFs. No account needed.');
}

export function contact(env = process.env, opts = {}) {
  const c = cfg(env);
  return page('Contact InvoiceGuard', `
<h1>Contact</h1>
<p>${who(c)}${c.country ? ', ' + esc(c.country) : ''} runs InvoiceGuard.</p>
${c.email ? `<div class="card"><h2>Email</h2><p><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></p></div>` : ''}
${opts.sent ? '<div class="note"><b>Thank you.</b> Your message was received. We aim to reply within a few working days, if you left an email address.</div>' : ''}${opts.err === '2' ? '<div class="note">Too many messages from your connection. Please try again later.</div>' : opts.err ? '<div class="note">Your message could not be sent. It must be 5 to 2000 characters, and the email address, if given, must be valid.</div>' : ''}
<div class="card"><h2>Send us a message</h2>
<form method="post" action="/contact"><p><label for="m">Message</label><br><textarea id="m" name="message" rows="6" maxlength="2000" required style="width:100%;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px"></textarea></p>
<p><label for="e">Your email, only if you want a reply (optional)</label><br><input id="e" name="email" type="email" maxlength="200" style="width:100%;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px"></p>
<p style="position:absolute;left:-9999px" aria-hidden="true"><label>Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label></p>
<p><button class="btn" type="submit" style="border:0;cursor:pointer;font:inherit;font-weight:600">Send</button></p></form>
<p class="mut">For questions, the free pilot, data requests (see the <a href="/privacy">privacy notice</a>) and bug reports. Please do not send passwords or customer data. Messages are stored on our own server only and deleted after 180 days. We aim to reply within a few working days.</p></div>
<h2>Free pilot</h2><p>We are looking for a few Amazon sellers who issue B2B invoices in the EU. You try InvoiceGuard for free, you tell us what is missing. The Amazon connection is still being approved, so today the pilot starts with sample data and your honest feedback. You can <a href="/sample">watch it work on made-up orders</a> first, no account needed. Many questions are answered in the <a href="/faq">FAQ</a>.</p>
<h2>Security issues</h2><p>If you find a security problem, please send us a message and give us a reasonable time to fix it before sharing it.</p>`, env, 'Contact the InvoiceGuard team or join the free pilot.');
}
