# Evidence-bound state transitions (owner ruling 5)

Principle. A financial-document state change needs all four of: (1) the meaning of the Amazon record together with its transaction type, (2) proof of identity, (3) evidence recency and ordering, (4) certainty about the outcome of the external operation. Missing or conflicting evidence never defaults to a state.

Three exits only:
- PROVEN: all four hold. The state is applied.
- UNRESOLVED: HOLD. No financial change. A person may record notes (effect none) but notes never change financial state.
- MANUAL AUTHORIZATION: a specific operational action by a named person, recorded with who, when, result and reason. It is never stored as an Amazon-attributed fact.

Gate map
| Path | Gate | Exit when not proven |
|---|---|---|
| Credit note verdict | src/cn-gate.js | HOLD, human decision bound to the evidence |
| Original SHIPMENT invoice verdict (InvoiceUploaded, Rejected, Processing) | src/orig-gate.js evaluateOriginalVerdict (independent of the credit note gate): number equals the stored document, rows agree on status and identity, Order ID, Shipping ID, marketplace, currency, amounts and sign at zero tolerance, report recency and attempt order | HOLD ORIGINAL_INVOICE_VERDICT_UNPROVEN, resolution only by new evidence |
| RETURN row with InvoiceUploaded, InvoiceRejected or InvoiceProcessing | openReturnHold | HOLD RETURN_ROW_INVOICE_STATUS, zero effect on the original, credit note or replacement. RETURN with CreditNotePending keeps its path |
| REFUND with InvoiceUploaded | existing hold | No human release until new trusted evidence (decision 1) |
| Unknown outcome after POST /feeds (B2) | unknownSettleCheck | HOLD. PROVEN lift only by a CANCELLED blocked feed or the keyed LATE_FEED confirmation. Otherwise one-shot authorizeUnknownRetry |
| Crash or FATAL feed | same | Authorization must name the feed id and its status and who checked Seller Central |

What the manual authorization is not: it does not claim that Amazon confirmed absence, it cannot release a late-landed document (that is the keyed LATE_FEED path), it is consumed by the one resend, and it cannot guarantee that an earlier request will not still land.

B2 is NOT closed. The residual risk is displayed in the Repairs screen next to the authorization form.
