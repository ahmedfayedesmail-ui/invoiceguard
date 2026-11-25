# KSeF TEST submission (done 2026-11-25 12:18 EET)
Run: python3 tools/ksef_test_submit.py FA3.xml  (needs python lxml, cryptography, requests). Refuses any base URL other than api-test.ksef.mf.gov.pl.
Verified end to end on https://api-test.ksef.mf.gov.pl/v2 with a random synthetic NIP: challenge, XAdES auth (self-signed cert, subject TINPL-<nip>), token redeem,
encrypted online session, invoice accepted (status 200, KSeF number issued). Example KSeF number: 4937754299-20261125-4F7C9C000000-37.
LABEL: "KSeF TEST environment, synthetic data. Not production verification." Test data is shared between integrators: never use real NIPs or invoices.
Sources: CIRFMF/ksef-api srodowiska.md, openapi.json, CIRFMF/ksef-docs auth docs, CIRFMF/ksef-client-csharp (SignatureService, CryptographyService, CertTestApp).
Update 12:34 EET: correction + UPO verified on TEST. Run: python3 tools/ksef_test_submit.py orig.xml - kor.xml (KOR file holds KSEF_NUMBER_PLACEHOLDER, replaced with the original's KSeF number).
Result: original 9897677246-20261125-516B1C000000-06 (200) and FA(3) KOR 9897677246-20261125-516CB9400000-0F (200, TypKorekty 2, refers to the original by KSeF number); session processed, 2/2 successful, UPO downloaded (1 page, issued by 'Ministerstwo Finansow - srodowisko testowe').
Not covered: production behaviour, amount corrections (StanPrzed rows), foreign-buyer rules, offline mode, UPO signature checking.
The PL pack stays HELD for real invoices until a verified content/correction rule is read from primary source.

## Amount corrections (added 2026-11-25)
buildFa3 accepts `corrects.before` (original lines) and optional `corrects.effect` (1 or 2, default 2). Original lines are written as FaWiersz rows marked StanPrzed=1, corrected lines follow as separate numbered rows. P_13/P_14/P_15 carry the DIFFERENCE, as the schema documentation states for faktury korygujace.
TEST result: original plus an amount-correction KOR (100 to 120 per unit, 2 units, net +40.00, VAT +9.20, gross +49.20) accepted, 2 of 2 successful, UPO downloaded (/downloads/ksef_test_upo_amount.xml). Synthetic data, KSeF TEST environment only. Not production verification and not a statement that PL issuing is allowed: the PL pack stays held.
Also TEST-accepted (2 of 2): a price decrease (100 to 80, net -40.00, VAT -9.20, gross -49.20) with TypKorekty 1. Not covered: multi-rate corrections.
Multi-rate (2026-11-25): lines may carry their own `rate` (23, 8 or 5; others still throw, not guessed). Totals are per rate group, corrections carry per-rate differences. TEST-accepted 2 of 2: original (23% and 8% lines, gross 300.00) plus KOR (net +40.00/VAT +9.20 at 23%, net -10.00/VAT -0.80 at 8%, gross difference 38.40), UPO /downloads/ksef_test_upo_multirate.xml. TEST environment, synthetic data, not production. Rates 0, exempt and reverse-charge cases are not built.
