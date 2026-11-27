"""Forensic audit of a sim run: every wrong, missed or unscorable result, tied to a seller, a scenario and a class.
Classes: ENGINE_BUG, HARNESS_BUG, UNSUPPORTED_SCENARIO, INSUFFICIENT_EVIDENCE.
usage: python3 sim/audit.py results.jsonl > sim/out/audit-v2.json"""
import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1])]
out = collections.defaultdict(lambda: {'sellers': [], 'count': 0})
def add(key, cls, cause, seller, n=1, **kw):
    e = out[key]; e.update({'class': cls, 'cause': cause}); e['sellers'].append(seller); e['count'] += n; e.update(kw)
for r in rows:
    s, sc = r['seller'], r['scenario']; c = r.get('conf'); ev = r.get('eval') or {}; r2 = r.get('round2') or {}
    notes = sum(n['count'] for n in r.get('covNotes', []))
    if c:
        if c['commercial']['conflictingEvidence']: add('A1 confident finding on conflicting is-amazon-invoiced / invoice-status', 'ENGINE_BUG', 'src/loop/project.js built the ordinary-invoice set A from invoice-status only and never read is-amazon-invoiced', s, c['commercial']['conflictingEvidence'])
        if c['commercial']['declarationDependent']: add('A2 same number, different content under a DOCUMENT declaration', 'INSUFFICIENT_EVIDENCE', 'documentLevel is the seller declaration; a file with several lines per number looks like a duplicate when DOCUMENT is declared. The file cannot prove which is right', s, c['commercial']['declarationDependent'])
        if c['commercial']['unscoredNonB2B']: add('A3 confident finding on a non-business order', 'ENGINE_BUG', 'src/loop/project.js never reads is-business-order (only src/vidr.js needsInvoice and src/manual.js do); probe: FALSE and TRUE give the same two confident findings', s, c['commercial']['unscoredNonB2B'])
        if c['source']['total']: add('A4 SOURCE_INCOMPLETE notice (file refused or unusable)', 'INSUFFICIENT_EVIDENCE', 'expected: the engine refuses the file and says so; a data-quality result, not a commercial claim', s, c['source']['total'])
    miss = ev.get('missed', [])
    for t in sorted(set(miss)):
        n = miss.count(t)
        if t == 'amazon_invoice_missing_from_books' and r['cohort'] == 'monthly_export':
            add('B1 gap not reported, books export ends before the report day (month-only)', 'INSUFFICIENT_EVIDENCE', 'booksCover needs the ledger period to span the shipment day and the report-taken day; otherwise absence cannot be concluded and the engine puts it in a coverage note', s, n, withNoteForSeller=notes > 0)
        elif t == 'number_differs_amazon_vs_books':
            add('B2 invoice number differs, same order', 'UNSUPPORTED_SCENARIO', 'project.js links by order, marks OTHER_NUMBER and writes a coverage note "comparison not part of this version"; disclosed, not detected', s, n, withNoteForSeller=notes > 0)
        elif t == 'books_doc_points_to_other_order':
            add('B3 books document points to another order', 'ENGINE_BUG', 'the number matches Amazon\'s, the order in the books does not; the engine matches by number and raises neither a finding nor a note', s, n, withNoteForSeller=notes > 0)
        else: add('B9 other miss ' + t, 'ENGINE_BUG', 'unclassified', s, n)
    m = r.get('mapping') or {}
    if 'error' in m or r.get('outcome') in ('blocked_mapping', 'blocked_kind_words'): add('C2 books file could not be loaded (blocked)', 'ENGINE_BUG', 'column or document-type words not recognised; mapping blocked', s)
    elif m and not m.get('auto'): add('C1 books columns not detected automatically (' + r['dialect'] + ')', 'ENGINE_BUG' if r['dialect'] in ('de', 'fr', 'it', 'nl', 'pl') else 'ENGINE_BUG', 'src/loop/ledger.js detectLedgerMapping has Spanish and English header words only', s)
    if r2.get('closedWrong') and sc == 'follow_up_stale_report': add('D1 stale-report round 2 closed gaps', 'HARNESS_BUG', 'the scenario expects an older report not to close a books gap, which is not what the contract says; expectation unproven, excluded from headlines', s, r2['closedWrong'])
    if r.get('expectPreflightBlock') and not (r.get('preflight') or {}).get('ready'): add('E1 blocked by preflight as expected', 'UNSUPPORTED_SCENARIO', 'by design (partial books, wrong report type, over 92 days, over 20000 rows)', s)
res = {k: {**v, 'sellers': sorted(set(v['sellers'])), 'seller_count': len(set(v['sellers']))} for k, v in sorted(out.items())}
print(json.dumps(res))
