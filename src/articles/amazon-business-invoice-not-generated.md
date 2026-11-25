
# Amazon Business invoice not generated? What to check and what to do

A business customer writes: "I cannot find the VAT invoice for my order." You check, and there is nothing. This happens to EU sellers more often than it should. Here is why, and a short routine to fix it.

*This is general information, not tax or legal advice. Rules differ by country. Confirm your own situation with your accountant.*

## The rule you are working against

Amazon's Business invoicing policy says sellers must provide Amazon Business customers with a valid VAT invoice for each order within one business day after dispatch is confirmed. If you are not required to charge VAT, you must provide a receipt instead. Credit notes for returns from business customers are due within one business day of the return being confirmed.

So "not generated" is not a cosmetic problem. It is a deadline you may already be missing.

## Who is supposed to generate it?

There are three setups, and the first step is knowing which one you are on:

1. **Amazon generates it.** You enrolled in the VAT Calculation Service (VCS) and chose "I want Amazon to generate invoices on my behalf".
2. **You generate it from Amazon's tax data.** You are in VCS and build invoices yourself from the VAT invoice data report, then upload them with SP-API.
3. **You generate it from your own data.** You create the invoice and upload it in Seller Central (Manage Orders) or through a third-party tool.

If you are on option 3, nothing appears unless you or your tool uploads it. Many "missing invoice" cases are simply this: nobody realised the upload was manual.

## Common reasons an invoice is missing

**1. The order is not in your VCS report yet.** Amazon's SP-API documentation says orders are available in the VAT Calculation Report three days after shipment. A customer asking on day one may see nothing even though the system is working. The VAT invoice data report, by contrast, lists a shipment right after dispatch.

**2. You are not enrolled, or the setting is wrong.** Check your VAT settings in Seller Central. If invoicing by Amazon is not selected, no invoice will be created for you.

**3. Missing or invalid VAT details.** An invoice needs your VAT registration for the relevant country and, for a reverse-charge or intra-EU sale, a valid buyer VAT number. If the buyer number is missing or fails the EU VIES check, the invoice cannot be finished correctly.

**4. Your VAT status is unclear.** Sellers not required to register for VAT can declare their exemption status so Amazon issues receipts. If that is not set, you can end up with neither invoice nor receipt.

**5. The order changed.** Cancellations, partial returns and address corrections mean a credit note or a corrected invoice is needed. The old invoice does not fix itself.

**6. Your upload failed quietly.** A file in the wrong format, a duplicate invoice number or a wrong order ID can mean the upload did not attach to the order.

## A routine to fix it today

1. **Find the order and the customer's request.** Note the dispatch date. Count one business day from it.
2. **Check which setup you use** (the three options above). That tells you who is responsible.
3. **Look at your invoice status.** In Seller Central, check whether the shipment shows as invoice pending or uploaded. If you use SP-API, the VAT invoice data report with the "pending invoices" option lists exactly the shipments waiting.
4. **Check the buyer VAT number.** Verify it in VIES. If it is invalid, ask the customer for the right number before you issue a VAT-exempt invoice.
5. **Issue the invoice** with your full seller details, buyer details, order date, a unique sequential number, VAT rate and amounts, or the correct reverse-charge wording where it applies.
6. **Upload it** and confirm it shows on the order.
7. **Write down what went wrong** so it does not repeat: wrong setting, failed upload, bad VAT number.

## Keep your sequence clean

A common mistake when rushing: reusing a number, skipping one, or editing an issued invoice. Do not edit an issued invoice. Issue a corrected invoice or a credit note and keep the original. Your accountant will thank you, and so will an auditor.

## When to automate

If you only have a few business orders a month, a spreadsheet and a calendar reminder can work. If you have dozens a week, the failure points above add up: late uploads, bad VAT numbers, numbering gaps.

InvoiceGuard is a small free pilot built for this. You upload the order report you download from Seller Central. It builds an invoice for each business order, checks the required details, numbering and the buyer VAT number in VIES, and holds anything it is unsure about with the reason, instead of guessing. You upload the finished PDFs to Amazon yourself.

To be straightforward about its limits: it is a pilot, it is not connected to Amazon, it does not file anything with a tax authority, it does not give tax advice, and we cannot promise any authority will accept a given invoice. There is a live sample on made-up orders that runs without an account: https://invoiceguard-production-b715c82a.up.railway.app/sample

## Quick checklist

- [ ] I know whether Amazon or I generate the invoice
- [ ] The order is past the point where Amazon's report should list it
- [ ] My VAT settings in Seller Central are correct
- [ ] The buyer VAT number passed VIES
- [ ] The invoice number is unique and in sequence
- [ ] The invoice is uploaded and visible on the order
- [ ] Any return has a matching credit note

## Sources

- Amazon Business invoicing policy (Amazon seller help)
- Amazon SP-API documentation, "Create and Upload Invoices": https://developer-docs.amazon/sp-api/docs/create-and-upload-invoices
