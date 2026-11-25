
# Amazon credit notes and rectificativas: how corrections actually work for EU sellers

Issuing the first invoice is the easy part. The mess starts when an order changes: a return, a wrong billing name, a bad VAT number, a price fix. Then you need a credit note or a corrective invoice, and the rules depend on who issued the original.

*General information, not tax or legal advice. Rules vary by country. Confirm your case with your accountant.*

## The two clocks

Amazon's Business invoicing policy sets two deadlines for Amazon Business orders. A valid VAT invoice is due within one business day after dispatch is confirmed. A credit note on a return is due within one business day after the return is confirmed. Corrections are a different story, covered below.

## Step 1: Who issued the original invoice?

Everything else follows from this.

- **Amazon issued it** through the VAT Calculation Service (VCS). You should not also issue invoices or credit notes for post-enrollment transactions. If you did issue a second invoice for the same transaction, Amazon's FAQ says you must cancel yours with a credit note.
- **You issued it**, from your own data or from Amazon's tax data. You are responsible for the credit note and the correction too.

## Step 2: What changed?

**A return.** Issue a credit note matching the original invoice, for the returned items and their VAT. For a partial return, only those items.

**Wrong billing name or address.** Amazon's docs say customers can ask Customer Service to correct an invoice only when they want to change the billing address or billing name. Nothing else is supported through that route. When it is confirmed and you upload your own invoices, two new transactions appear in the VAT invoice data report: a reversal (type REFUND), for which you upload a credit note, and a corrected transaction, for which you upload a new invoice. Amounts stay the same. Both uploads need the transaction ID, or Amazon rejects them. Amazon also notes that these correction documents are not counted in the Invoice Defect Rate.

If Amazon issued the invoice through VCS, it creates the credit note and the new invoice itself.

**Any other change** (price, VAT rate, product, wrong buyer VAT number). For VCS invoices, Amazon's FAQ says to cancel the invoice with a credit note and issue a new invoice according to the customer's request. For your own invoices the principle is the same: do not edit what you issued. Reverse it and issue the right one.

## What a Spanish rectificativa is

In Spain, a factura rectificativa is a corrective invoice. According to the Agencia Tributaria's VAT manual, you must issue one when:
- the original invoice lacks required content (articles 6 and 7 of Real Decreto 1619/2012);
- the VAT charged was calculated wrongly;
- the taxable base changes under article 80 of the VAT law (returns, discounts, cancelled operations, price changes, bad debts).

The rectificativa must say it is corrective and identify the invoice it corrects. It goes in its own numbering series (Real Decreto 1619/2012, article 6). You can show either the correction amount itself or the amounts as they stand after the correction, as long as the correction amount is stated. It is due as soon as you know the reason that requires it. The four-year limit runs from when the tax became chargeable (or from the date of the article 80 event, such as a return or cancellation), not from the invoice date.

Amazon's term is "credit note". Spanish practice says "rectificativa" or "abono". The idea is the same: the original stays, and a linked document corrects it. Ask your gestor which form fits each case.

## The five mistakes we see described most

1. Editing an issued invoice instead of reversing it.
2. Issuing your own invoice when Amazon already issued one through VCS.
3. Uploading a credit note without the transaction ID Amazon asks for.
4. Putting credit notes in the same number series as invoices when your country wants a separate one.
5. Forgetting to link the correction to the original document.

## A simple correction routine

1. Identify the original document and who issued it.
2. Decide: return, billing-name/address fix, or other.
3. Issue the credit note or rectificativa with its own number and a clear reference to the original.
4. If a new invoice is needed, issue it with the right details.
5. Upload both to the order with the correct transaction ID where required.
6. Keep the pair together in your records.

## Where InvoiceGuard fits

InvoiceGuard is a free pilot. You upload the order report from Seller Central, it builds and checks invoices for business orders, and it handles corrections as linked documents instead of edits, with a tamper-evident log of what was issued. Anything doubtful is held with the reason.

It is not connected to Amazon. You upload the PDFs yourself. It does not file with any tax authority, it is not tax advice, and we cannot promise any authority will accept a given document. The live sample uses made-up orders and needs no account: https://invoiceguard-production-b715c82a.up.railway.app/sample

## Sources

- Amazon Business invoicing policy (Amazon seller help)
- Amazon VAT calculation service FAQ: https://sellercentral-europe.amazon.com/help/hub/reference/external/G202120340?locale=en-GB
- Amazon SP-API, "Invoice Compliance and Correction": https://developer-docs.amazon/sp-api/docs/invoice-compliance-and-correction
- Agencia Tributaria, "Facturas de rectificación" (Manual IVA 2026): https://sede.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-practicos/manual-iva-2026/capitulo-10-obligac-formales-suj-registro/obligaciones-materia-facturacion/facturas-rectificacion.html
- Real Decreto 1619/2012, BOE-A-2012-14696
