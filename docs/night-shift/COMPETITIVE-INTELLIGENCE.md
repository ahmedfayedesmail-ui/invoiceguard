# COMPETITIVE-INTELLIGENCE (night mission WP5, Nov 27 2026)
Method: public pages read on 2026-11-27 with a page fetch. Every claim names its URL and the date shown on the page (or "no date shown"). Vendor pages are marketing: a statement is recorded as "the vendor states", never as proven. "Not demonstrated" means not found on the pages read, NOT "does not exist". No competitor capability or price is invented. Prices are as printed on the page at the access date and can change.

## 1. The ground rules from Amazon (primary sources)
- Amazon VCS best practices (no date shown) https://developer-docs.amazon/sp-api/docs/vcs-best-practices : request the VIDR at least twice a day; use Amazon's tax calculation; sellers who do not upload within one business day after shipment can be removed from VCS and lose the Downloadable VAT Invoice badge; one invoice per shipment (an order can split into shipments).
- Create and upload invoices (no date shown) https://developer-docs.amazon/sp-api/docs/create-and-upload-invoices : invoice statuses include InvoiceUploaded, InvoiceRejected (seller must upload again), CreditNotePending, CreditNoteRejected, InvoiceCreatedByAmazon, NoTaxCalculated.
- Changelog 2026-03-25 https://developer-docs.amazon/sp-api/changelog/vat-calculation-service-updates : from 1 June 2026 VCS calculates tax at SHIPMENT level by tax rate instead of per unit, in ten EU marketplaces. Integrators that do not update "may create incorrect invoices". Also a KSeF number column added for Poland from 1 April 2026.
  IMPLICATION FOR US (own finding, not a vendor claim): Stage 1 carries a rounding tolerance (1 cent, 2 cents for quantity above 1) that was set as an unproven hypothesis. The Amazon change means the per-unit assumption behind any per-line arithmetic check needs a real post-June VIDR to confirm. Not changed tonight; listed in STAGE-1-REMAINING-RISKS.md.

## 2. Who is in the space (what they say)
| Vendor | What the vendor states | Source and date |
|---|---|---|
| GoRoute | Amazon connector for sellers who upload their own invoices: reads orders, VIDR and upload results; turns business orders into e-invoices (Peppol where required); uploads the PDF to Amazon; holds shipments with a stated reason; counts shipments past Amazon's business day without an accepted upload; says the connector is new (September 2026) and awaiting Amazon's review for the Tax Invoicing role; plans: Free with 50 invoices a month, paid from $19 a month | https://docs.goroute.ai/docs/connectors/amazon (no date) ; https://goroute.ai/amazon-e-invoicing-sellers.html (no date) |
| eCommerce One | three paths: Amazon issues (replica), VCS Lite (invoice from VIDR figures), own tax determination; keeps shipments of one order linked | https://www.ecommerce-one.app/en/amazon-invoices (no date) |
| Billbee | automatic Amazon invoices; page shows a base fee from 9 EUR a month plus a small per-order fee | https://www.billbee.io/en/invoices/amazon (no date) |
| SimpleVAT | VCS Lite generation and upload; Lite 25 EUR a month (up to 60 orders), Pro 60 EUR a month (up to 5000 orders), both incl. automated invoicing and VAT/OSS reports | https://www.simplevat.eu/vat-filing/ and https://www.simplevat.eu/configuration-guide-for-amazon-vat-calculation-service-lite/ (no date) |
| Amainvoice | VCS Lite / IDU interfaces; says VCS risks are unchecked VAT IDs, broken number ranges and missing EN 16931 conformity; price "from 43 EUR a month" scaled by document volume | https://www.amainvoice.de/wissen/amazon-vcs-risiken-margenschutz (2026-07-01) |
| M2E Pro | uploads Magento invoices and credit memos to Amazon EU; its help page (modified 2024-07-31) says the Amazon API did not return an upload confirmation and the seller must check Seller Central | https://help.m2epro.com/en/support/solutions/articles/9000219394-how-to-set-up-automatic-invoice-uploading-for-amazon-european-accounts |
| easybill, JTL, PlentyONE, Lengow | ERP and tool integrations that create and upload own invoices for VCS Lite (easybill page updated 2026-09-16) | https://support.easybill.de/hc/de/articles/360001336805-Einstellungen-Upload-von-Rechnungen-zu-Amazon-bei-Nutzung-des-Umsatzsteuer-Berechnungsservice-VCS-lite ; https://guide.jtl-software.com/jtl-eazyauction/amazon-einrichten/amazon-umsatzsteuer-berechnungsservice-mit-eigenem-rechnungsupload-einrichten/ ; https://help.plentyone.com/hc/en-gb/sections/31177106704018 ; https://help.lengow.com/hc/en-us/articles/360026923372-Amazon-VCS |
| Amazon VCS itself | free; Amazon issues the invoice | https://base.com/en-EN/blog/amazon-vat-calculation-service-what-it-covers-and-misses/ (2026-09-21, third-party blog) |

## 3. What they do well (from their own pages)
Create and upload at scale, tied into an ERP the seller already has; Peppol and national e-invoice formats (GoRoute); a free or cheap entry (GoRoute free tier, SimpleVAT 25 EUR, Billbee 9 EUR base); holding shipments with a named reason (GoRoute); numbering schemes and design; accountant exports (FloOne DATEV, https://floone.de/loesungen/amazon-buchhaltung).

## 4. What is not demonstrated on those pages
- Held reasons shown by GoRoute are about the buyer VAT number, Peppol reachability and Peppol rule failures. A hold for an internally contradictory report (amounts that do not add up, conflicting rows, unreadable numbers) is not shown on the pages read.
- A recorded human decision tied to the exact evidence (user, time, reason, evidence fingerprint) that reopens when the file changes: not shown.
- Cross-document reconciliation with an explicit "unexplained amount": not shown.
- Per-line evidence of why a shipment was not issued: not shown.
- Exact rejection loop for Amazon's InvoiceRejected / CreditNoteRejected with a safe re-upload that never creates a second invoice: GoRoute says it reads the processing report; the others do not describe it on the pages read.
- M2E Pro's statement about missing upload confirmation is from 2024 and may be outdated.

## 5. Where InvoiceGuard can differ (and where it cannot yet)
Honest position: InvoiceGuard is a Concierge Pilot, sample data only, no real seller cycle yet. Nothing below is a claim about production.
1. Pre-issuance integrity gate with ledger (built, Stage 1): never guess, hold with a reason, BLOCK / HOLD / INFO.
2. Evidence-first governance: append-only decisions and history (built).
3. Reconciliation with unexplained amounts (designed, not built: RECONCILIATION-ARCHITECTURE.md).
4. Seal of the issued document (designed, Stage 2, not started).
Not a differentiator: invoice design, dashboards, e-invoice formats and Peppol (GoRoute is ahead and funded for it), price (free tiers exist).

## 6. What could justify a paid subscription
A seller pays to avoid a loss they can name: losing the Downloadable VAT Invoice badge through late or rejected uploads; a wrong invoice that must be corrected; an audit where they cannot show why an invoice was or was not issued. So the paid value is (a) fewer wrong or late documents and (b) an evidence record. Cosmetic ideas rejected: invoice themes, a generic dashboard, an AI chat on invoices, extra export formats without a stated customer, gamified scores.

## 7. Opportunities, ranked (my judgement, 1 low to 5 high; risk 5 = most risky)
| Opportunity | Customer value | Feasibility | Defensibility | Risk | Note |
|---|---|---|---|---|---|
| Integrity gate with reasons (built) | 4 | 5 | 3 | 2 | needs real files to tune |
| Rejection and late-upload loop with safe re-upload | 5 | 3 | 3 | 3 | needs the real Amazon cycle |
| Reconciliation with unexplained amount | 4 | 2 | 4 | 3 | needs Order and All Orders reports, real data |
| Evidence pack for an audit | 4 | 4 | 4 | 2 | depends on seal and decisions |
| Check of the June 2026 shipment-level change against real VIDRs | 4 | 4 | 2 | 2 | protects correctness now |
| Peppol / e-invoice formats | 3 | 1 | 1 | 4 | competitors ahead, skip |
| Design, dashboards, AI chat | 1 | 5 | 1 | 1 | rejected |

## 8. Limits of this research
Pages were read once on 2026-11-27. No vendor was contacted, nothing was signed up for, no price beyond what is printed was assumed. Marketing claims (for example Amainvoice's coverage claims) are not verified.
