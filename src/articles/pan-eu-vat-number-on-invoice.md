
# Pan-EU selling: which VAT number goes on your Amazon Business invoice?

You registered in Spain, you also have a German VAT number, and Amazon moves your stock between warehouses. A business customer in Italy orders. Which of your numbers belongs on the invoice? This is one of the most common mix-ups for Pan-EU sellers, and it is easy to get wrong in both directions.

*General information, not tax or legal advice. Which registration applies to a sale depends on your setup. Your accountant makes that call.*

## The short answer

The seller VAT number on a B2B invoice generally follows **where the goods were dispatched from**, not where you live and not where the customer is. Amazon's own VAT Calculation Service works that way: it issues an invoice only when you have given it a valid VAT number for the country the shipment left from.

## Where the confusion starts

Two things get mixed up:

1. **Your home tax ID** (for example a Spanish CIF/NIF used for domestic business).
2. **Your VAT registrations in each country** where you store stock.

For Pan-EU FBA, Amazon says a VAT number is required for each country where goods are stored. Moving your own stock across a border is itself treated as a taxable transfer, so storage countries mean registrations. Once you have several, each shipment can carry a different seller number.

## What Amazon's documents say

- Amazon's VAT Calculation Service FAQ explains that it can only generate invoices for orders dispatched from EU or UK countries **and** for which you have provided eligible VAT numbers. An EU number has to be valid in VIES.
- **Example A** in the FAQ: you entered a local Spanish VAT number, the goods ship from Spain, but that number is not valid in VIES. Amazon does not calculate tax or generate the invoice. You must do it yourself.
- The VCS developer guide describes the status "NoTaxCalculated" for shipments where the seller has not uploaded a VAT number for the dispatch country. Its example is a Pan-EU FBA seller with no number for the Czech Republic whose stock ships from there.
- The same guide notes that if one order is split across fulfilment centres in two countries, you need two invoices, and the seller VAT number on each can differ.
- Amazon's best-practice guidance says to always include the seller's VAT number (and the buyer's where applicable). Invoices without the seller VAT number, where one applies, are not VAT invoices.

## Why this becomes a deadline problem

Amazon Business invoices are due within one business day of dispatch confirmation. If Amazon cannot generate the invoice because of a number mismatch, nobody notices until you are already late, unless you check the pending list or the VAT invoice data report (invoice status "NoTaxCalculated").

## A check you can run today

1. **List your registrations.** For each country where Amazon may hold your stock, write down the VAT number you have there.
2. **Compare with Seller Central.** Are all of them entered in your VAT settings? Is each valid in VIES?
3. **Check the ship-from for recent shipments.** Pull the VAT invoice data report with all statuses and look for "NoTaxCalculated".
4. **For those shipments**, issue the invoice yourself, using the seller VAT number for the dispatch country as advised by your accountant, and upload it.
5. **Check split shipments.** One order, two warehouses, two invoices.
6. **Check the buyer side.** The customer's VAT number should be present and valid in VIES before you treat a sale as VAT-exempt for a business buyer.

## The mistakes to avoid

- Using one home-country number on every invoice because it is the one you remember.
- Entering a number in Seller Central that is not valid in VIES and assuming Amazon will cope.
- Forgetting a new storage country after Amazon redistributes stock.
- Treating OSS as a replacement for local registrations. OSS covers cross-border B2C distance sales, not local sales from a warehouse or transfers of your own stock.

## Where InvoiceGuard fits

InvoiceGuard is a free pilot for sellers who invoice business orders. It reads the order report you download from Seller Central, builds each invoice, and shows where your shipments left from so the VAT-number conversation with your accountant starts from facts. It checks buyer VAT numbers in VIES and holds anything it is not sure about, with the reason, instead of guessing.

It does not decide which registration applies, it does not give tax advice, it is not connected to Amazon and does not file anything with a tax authority. We also cannot promise any authority will accept a given invoice. Try the sample on made-up orders, no account needed: https://invoiceguard-production-b715c82a.up.railway.app/sample

## Sources

- Amazon VAT calculation service FAQ: https://sellercentral-europe.amazon.com/help/hub/reference/external/G202120340?locale=en-GB
- Amazon VCS Developer Guide: https://developer-docs.amazon/sp-api/docs/vat-calculation-service-guide
- Amazon VCS Best Practices: https://developer-docs.amazon/sp-api/docs/vcs-best-practices
- Amazon VCS example use cases: https://developer-docs.amazon.com/sp-api/docs/vat-calculation-service-example-use-cases
- Amazon Business invoicing policy (Amazon seller help)
- Taxually, "Amazon FBA VAT in Europe 2026: Pan-EU Guide": https://www.taxually.com/blog/amazon-fba-vat-europe-guide
