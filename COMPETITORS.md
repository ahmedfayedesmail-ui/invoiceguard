# Competitor gaps and chosen edges (research date 24 Nov 2026)

Method: public docs and product pages only. "No public mention" means I did not find it in the pages below, not that the product lacks it.

## What Amazon itself does (developer-docs.amazon.com)
- VCS option 1: Amazon issues invoices for enrolled sellers. Option 2/3: seller uploads own PDF via Feeds API `UPLOAD_VAT_INVOICE` (restricted "Tax Invoicing" role). Error 79509 says invoice upload is "in a closed beta" for sellers who did not choose self-invoicing in VCS.
- Corrections: Amazon supports changing only billing name and address. It then creates two VIDR transactions: a REFUND `CorrectionReversal:...` (seller must upload a credit note with that transaction ID) and a SHIPMENT `Correction::...` (seller must upload a new invoice with that transaction ID). Missing transaction ID means rejection. Correction uploads do not count in Invoice Defect Rate.

## Competitors
| Tool | What public pages show | Gap vs our target |
|---|---|---|
| GoRoute (new, Sept 2026) | Pull connector for VCS sellers who self-invoice; focus on e-invoice formats (Peppol, XRechnung); its own docs say its SP-API app still awaits Amazon's Tax Invoicing review | Closest rival. Format/e-invoicing focus. No public mention of the correction credit-note + new-invoice pair or a VIES hold |
| Quaderno | Imports orders, auto-creates invoices; Amazon upload is a toggle "Autosend all automatic invoices and credit notes" | No public mention of Amazon correction pairs, VIES pre-check, or holding bad invoices |
| Holded | Imports Amazon orders; user selects shipped orders and clicks Convert to invoice | Manual conversion step; no public mention of upload to Amazon |
| M2E Pro | Auto invoice upload for Amazon EU accounts | General marketplace sync tool; invoice logic is secondary |
| Amainvoice (Appstore) | Accounting records, OSS, VAT compliance for tax advisers | Accounting focus, not B2B invoice deadline/corrections |
| Amazon VCS | Free, automatic | Only for enrolled sellers; no help when VCS cannot tax (NoTaxCalculated), self-invoice sellers, or Spanish rectificativa rules |

## Edges built (in code, tested)
1. Correction automation: reads Amazon's correction transactions, issues the credit note (rectificativa por diferencias, series R) and the replacement invoice (por sustitución) with the right transaction IDs, no duplicates.
2. Never upload a wrong invoice: buyer VAT checked live in VIES before issue; invalid means hold with a plain reason; VIES outage means retry, not reject.
3. Tamper-evident audit log (hash chain) of every issued document.
4. Plain-language Amazon errors (closed beta, missing Tax Invoicing role).
5. Zero cost to run.

## Verifactu 2027: deprioritized
- Legal dates today (AEAT note, law RDL 15/2025): 1 Jan 2027 for corporate-tax payers, 1 Jul 2027 for others.
- Hacienda announced on 5 Oct 2026 a planned deferral to Oct 2028 to align with B2B e-invoicing (for businesses under 8M EUR). Press and tax sites on 20-23 Nov say it is not yet in the BOE.
- Decision: do not lead with Verifactu. The audit chain is groundwork only and is not a Verifactu record. Full module (AEAT record format, submission, certificate, declaración responsable) waits until the BOE settles.

## Sources
developer-docs.amazon.com/sp-api/docs/create-and-upload-invoices, .../invoice-compliance-and-correction, .../vcs-error-handling, .../invoicing-feed-type-values; docs.goroute.ai/docs/connectors/amazon; goroute.ai/amazon-e-invoicing-sellers.html; support.quaderno.io/article/627-uploading-invoices-to-amazon-eu; holded.com/en-us/integrations/amazon; help.m2epro.com (invoice uploading); sede.agenciatributaria.gob.es (nota informativa ampliación plazo SIF); hacienda.gob.es/sgt/gabsehacienda/nota-informativa-verifactu.pdf; europapress.es (5 Oct 2026); simplifico.es/blog/verifactu-plazos-estado-20-noviembre-2026
