// Public pages: landing, privacy, contact. Plain HTML, no scripts, no cookies, no third-party requests.
// Operator details come from the environment so nothing is invented: OPERATOR_NAME, CONTACT_EMAIL, OPERATOR_COUNTRY.
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UPDATED = '25 November 2026';
const CSS = `:root{--ink:#14202b;--mut:#5d6b78;--line:#e4e9ee;--bg:#f5f7f9;--pri:#0f766e;--priD:#0b5a54}*{box-sizing:border-box}body{margin:0;font:16px/1.65 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{background:#fff;border-bottom:1px solid var(--line);padding:14px 20px;display:flex;align-items:center;gap:18px;flex-wrap:wrap}.logo{font-weight:700;font-size:19px;letter-spacing:-.02em;color:var(--ink);text-decoration:none}.logo b{color:var(--pri)}.sp{flex:1}
nav a{color:var(--mut);text-decoration:none;margin-left:16px;font-size:15px}nav a:hover{color:var(--ink)}
.btn{display:inline-block;background:var(--pri);color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600}.btn:hover{background:var(--priD)}.btn.alt{background:#fff;color:var(--pri);border:1px solid var(--pri)}
main{max-width:860px;margin:0 auto;padding:28px 20px 60px}.hero{padding:34px 0 12px}h1{font-size:clamp(28px,5vw,40px);line-height:1.15;margin:0 0 14px;letter-spacing:-.02em}h2{font-size:22px;margin:34px 0 8px}h3{font-size:17px;margin:20px 0 4px}
p{margin:0 0 12px}.lead{font-size:19px;color:#2d3b47}.mut{color:var(--mut)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin:16px 0}.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px}.card h3{margin-top:0}
.note{background:#fff8e6;border:1px solid #f3dca0;border-radius:10px;padding:12px 16px;font-size:15px;margin:18px 0}ul{padding-left:22px;margin:0 0 12px}li{margin:4px 0}
footer{border-top:1px solid var(--line);background:#fff;padding:20px;text-align:center;color:var(--mut);font-size:14px}footer a{color:var(--mut);margin:0 10px}table{border-collapse:collapse;width:100%;font-size:15px;background:#fff}td,th{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}th{background:#f0f3f6}
@media(max-width:560px){nav a{margin-left:10px}}`;
const cfg = (env) => ({ name: String(env.OPERATOR_NAME ?? '').trim(), email: String(env.CONTACT_EMAIL ?? '').trim(), country: String(env.OPERATOR_COUNTRY ?? '').trim() });
const page = (title, body, env, desc) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(desc ?? 'InvoiceGuard helps Amazon sellers issue and check B2B invoices.')}"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><style>${CSS}</style></head><body>
<header><a class="logo" href="/">Invoice<b>Guard</b></a><span class="sp"></span><nav><a href="/#how">How it works</a><a href="/privacy">Privacy</a><a href="/contact">Contact</a></nav><a class="btn" href="/app">Open the app</a></header>
<main>${body}</main>
<footer><a href="/">Home</a><a href="/privacy">Privacy</a><a href="/contact">Contact</a><div style="margin-top:8px">InvoiceGuard is a pilot-stage tool. It is not tax or legal advice.</div></footer></body></html>`;
const who = (c) => c.name ? esc(c.name) : 'the InvoiceGuard operator';
const contactLine = (c) => c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : 'the contact address on the <a href="/contact">contact page</a>';

export function landing(env = process.env) {
  return page('InvoiceGuard: B2B invoices for Amazon sellers, checked before they go out', `
<section class="hero"><h1>Amazon Business invoices, checked and ready on time.</h1>
<p class="lead">You upload the order report you download from Seller Central. InvoiceGuard builds an invoice for each business order and checks it against the rules before you send anything. If something looks wrong, it stops and tells you what to fix, in plain English.</p>
<p><a class="btn" href="/app">Try it with sample data</a> &nbsp; <a class="btn alt" href="/contact">Join the free pilot</a></p></section>
<div class="note"><b>Honest status:</b> InvoiceGuard is a pilot. It is not connected to Amazon. You upload your own order report and you upload the finished invoices to Amazon yourself. The sample data in the app is made up, and nothing from it is sent to Amazon. We say so on every screen that shows sample data. We have not yet tested on a real Seller Central file.</div>
<h2>Who it is for</h2><p>Sellers who sell to businesses on Amazon in the EU and want invoices that are complete, numbered in order, and issued on time, without doing it by hand. It is built for small teams, not accountants.</p>
<h2 id="how">How it works</h2>
<div class="grid"><div class="card"><h3>1. You upload your order report</h3><p>Download it from Seller Central and drop it in. We read the business orders and skip the rest.</p></div>
<div class="card"><h3>2. It builds and checks the invoice</h3><p>Required details, buyer VAT number, numbering and deadlines are checked before the invoice is final.</p></div>
<div class="card"><h3>3. You download the pack</h3><p>You get the PDFs, a list, and short steps for uploading them to Amazon. Anything we are unsure about is held with the reason. We never guess.</p></div></div>
<h2>What you get</h2><ul><li>A simple dashboard: what was invoiced, what is held and why.</li><li>Invoices as PDFs, in the buyer's language where supported, and corrections when an order changes.</li><li>Buyer VAT numbers checked in the EU VIES service when you ask.</li><li>A tamper-evident log of every invoice issued.</li><li>Country rules kept as data. Each rule shows its source, the date we last verified it, and a status: verified, secondary or unverified. A rule we cannot verify blocks issuing instead of being assumed.</li></ul>
<h2>What it does not do</h2><ul><li>It does not give tax or legal advice. Confirm your own situation with your adviser.</li><li>It does not file anything with a tax authority.</li><li>Some countries are on hold until we have read the official legal text. The app tells you which.</li><li>The "defect rate" figure in the app is our own estimate, not an Amazon figure.</li></ul>
<h2>Your data</h2><p>We keep only what the service needs, we do not sell it, and we do not use advertising or analytics trackers. Read the <a href="/privacy">privacy page</a> for the details.</p>
<h2 id="pricing">Pricing</h2><p>InvoiceGuard is free during the pilot. We have not set paid plans yet. If we introduce them, the prices will be shown here before anyone is charged, and pilot users will be told first.</p>
<h2>Free pilot</h2><p>We are looking for a few sellers to try InvoiceGuard for free and tell us what is missing. See the <a href="/contact">contact page</a> to get in touch.</p>`, env, 'InvoiceGuard builds and checks B2B invoices for Amazon sellers in the EU. Pilot stage, honest about what works today.');
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
<tr><td>The order report you upload (order number, date, totals, buyer name, buyer country and buyer VAT number): order number, date, totals, buyer name, buyer country and buyer VAT number</td><td>To build and check invoices. In demo mode these are made-up sample data.</td></tr>
<tr><td>Invoices we issue for you and a log of what was issued and when</td><td>So you have your records and they cannot be quietly altered.</td></tr>
<tr><td>Your Amazon connection credentials, encrypted (AES-256-GCM) with a key held only on the server</td><td>Only if a direct Amazon connection is switched on, which it is not today.</td></tr>
<tr><td>A security log: time, type of event (sign-in, failed sign-in, password change), your network address, and a short fingerprint of the email, never the password</td><td>To spot and investigate attacks. Kept for 13 months.</td></tr>
<tr><td>A sign-in cookie</td><td>To keep you signed in. It is strictly necessary, HttpOnly and Secure. We set no other cookies.</td></tr></table>
<h2>Who else sees data</h2><ul>
<li><b>EU VIES service</b> (European Commission): when a buyer VAT number is checked, the number is sent to VIES to find out whether it is valid.</li>
<li><b>Amazon</b>: nothing is sent to Amazon from this service. You upload your invoices yourself.</li>
<li><b>Our hosting provider</b> (Railway) stores the database and runs the service, in a data centre that may be outside the EU.</li>
<li>We do not sell data, share it for advertising, or give it to anyone else, unless the law requires it.</li></ul>
<h2>Amazon data</h2><p>Data we receive from Amazon is used only to prepare, check and keep your invoices for you. We do not use it for marketing, we do not combine it with other sources, and we do not share it with other sellers.</p>
<h2>How long we keep it</h2><p>Account details are kept while your account is active. Buyer personal data that comes from Amazon is kept only as long as it is needed to issue and keep the invoice, and only as long as Amazon's data protection rules and the tax rules that apply to you allow. Invoices may have to be kept for years under those tax rules. When you ask us to delete your account, we delete its data, or return it to you first, and we tell you if something has to be kept by law.</p>
<h2>Your rights</h2><p>If the EU GDPR applies to you or your buyers, you can ask us to show you your data, correct it, delete it, or hand it over in a usable file, and you can object to how it is used. Email ${contactLine(c)}. We aim to reply within 30 days. You can also complain to your local data protection authority.</p>
<h2>Security</h2><p>Connections use HTTPS. Passwords must be at least 12 characters and are hashed. You can turn on two-step sign-in with an authenticator app. Accounts lock for a while after repeated wrong passwords. Amazon credentials are encrypted. Buyer names and billing addresses are removed from our order records 30 days after shipment. Write requests are checked against cross-site attacks, sign-in attempts are rate limited, and each page sends security headers. No system is perfectly safe; if we ever learn of a breach that affects you, we will tell you.</p>
<h2>Changes</h2><p>If we change this notice in a way that matters, we will update the date above and tell active users.</p>`, env, 'How InvoiceGuard handles your data.');
}

export function contact(env = process.env) {
  const c = cfg(env);
  return page('Contact InvoiceGuard', `
<h1>Contact</h1>
<p>${who(c)}${c.country ? ', ' + esc(c.country) : ''} runs InvoiceGuard.</p>
<div class="card"><h3>Email</h3><p>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : 'Contact details are being set up.'}</p><p class="mut">For questions, the free pilot, data requests (see the <a href="/privacy">privacy notice</a>) and bug reports. We aim to reply within a few working days.</p></div>
<h2>Free pilot</h2><p>We are looking for a few Amazon sellers who issue B2B invoices in the EU. You try InvoiceGuard for free, you tell us what is missing. The Amazon connection is still being approved, so today the pilot starts with sample data and your honest feedback.</p>
<h2>Security issues</h2><p>If you find a security problem, please email us and give us a reasonable time to fix it before sharing it.</p>`, env, 'Contact the InvoiceGuard team or join the free pilot.');
}
