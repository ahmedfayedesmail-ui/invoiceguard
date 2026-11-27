#!/usr/bin/env python3
# Builds the case files for the 59 and the 83 from per-seller dumps written by tools/audit-v1.sh. Reads only synthetic data.
import json, sys, csv, os
src, out59, out83 = sys.argv[1], sys.argv[2], sys.argv[3]
S59 = [21,56,91,126,161,196,231,266,301,336,371,406,441,476]; S83 = [24,59,94,129,164,199,234,269,304,339,374,409,444,479]
def load(i): return json.load(open(f'{src}/seller-{i}.json'))
def vrows(d):
    L = d['vText'].split('\n'); H = L[0].split('\t'); return [dict(zip(H, l.split('\t'))) for l in L[1:] if l]
def ledger_numbers(d):
    delim = d['profile'].get('delimiter', ';'); return [l.split(delim)[0].lstrip('\ufeff') for l in d['lText'].split('\n')[1:] if l]
cases59 = []
for i in S59:
    d = load(i); vr = vrows(d); nums = set(ledger_numbers(d)); tx = {t['order']: t for t in d['txs']}
    for it in d['issues']:
        if it['family'] != 'BOOKS_GAP' or it['state'] != 'ACTION_REQUIRED': continue
        sj = it['subject']; rows = [r for r in vr if r['order-id'] == sj['orderId'] and r['transaction-id'] == sj['transactionId']]
        r = rows[0]; num = r['invoice-number']
        cases59.append({'seller': i, 'scenario': d['scenario'], 'issueKey': it['key'], 'finding': f"{it['family']}/{it['subtype']}/{it['state']}",
            'amazonTransactionId': sj['transactionId'], 'orderId': sj['orderId'], 'shippingId': sj['shippingId'], 'marketplace': sj['marketplace'], 'amazonInvoiceNumber': num,
            'engineEvidence': {'invoice-status': r['invoice-status'], 'invoiceNumberAtAmazon': num, 'numberInAccountingFile': num in nums, 'amazonRowRef': 'data row ' + str(vr.index(r) + 1)},
            'counterEvidenceInTheSameRow': {'is-amazon-invoiced': r['is-amazon-invoiced'], 'meaning': 'the report itself says Amazon issued this invoice'},
            'rowsOfThisTransaction': len(rows), 'harnessTruthAmazonInvoiced': bool(tx[sj['orderId']].get('amzInv')),
            'whatTheFileProves': 'Two fields of one row contradict each other: is-amazon-invoiced=TRUE (Amazon issued it) and invoice-status=' + r['invoice-status'] + ' (a document was uploaded). The file cannot say which one is right. A confident ACTION_REQUIRED needed one of them to be right.'})
cases83 = []
for i in S83:
    d = load(i); vr = vrows(d); lvl = d['ldecl'].get('documentLevel'); delim = d['profile'].get('delimiter', ';')
    byNum = {t['num']: t for t in d['txs']}
    for it in d['issues']:
        if it['family'] != 'DUPLICATE_DOCUMENT' or it['state'] != 'ACTION_REQUIRED': continue
        ev = it['finding']['evidence']; rows = ev['sources'][0]['rows']; cells = [json.dumps(r['cells'], sort_keys=True) for r in rows]; num = it['subject']['number']
        t = byNum.get(num, {}); vm = [r for r in vr if r['invoice-number'] == num]
        cases83.append({'seller': i, 'scenario': d['scenario'], 'issueKey': it['key'], 'finding': f"{it['family']}/{it['subtype']}/{it['state']}", 'documentNumber': num, 'marketplace': it['subject']['marketplace'],
            'amazonTransactionIds': sorted({r['transaction-id'] for r in vm}), 'orderIds': sorted({r['order-id'] for r in vm}), 'shippingIds': sorted({r['shipping-id'] for r in vm}),
            'engineEvidence': {'rowRefs': ev['rowNumbers'], 'rowsInFile': len(rows), 'allRowsByteIdentical': len(set(cells)) == 1, 'declaredDocumentLevel': lvl, 'declaredBy': 'seller, in the accounting import declaration'},
            'counterEvidenceInTheFiles': 'none: every row carries the same number, date, currency, total, net, VAT and order, and the seller declared that one row is one whole document',
            'harnessMetadataOnly': {'linesOfThisDocumentInTheGenerator': t.get('lines'), 'generatorNote': 'seller mis-declared one row = one document'},
            'wrongnessDemonstrableFromTheFiles': False})
cases59.sort(key=lambda c: (c['seller'], c['orderId'], c['amazonTransactionId']))
cases83.sort(key=lambda c: (c['seller'], c['documentNumber']))
for c in cases59 + cases83: c.pop('issueKey')  # the key changes from run to run (it hashes import ids that carry the run clock), so it is not part of a case's identity
json.dump(cases59, open(out59 + '/cases.json', 'w'), indent=1); json.dump(cases83, open(out83 + '/cases.json', 'w'), indent=1)
for path, cs in ((out59, cases59), (out83, cases83)):
    with open(path + '/cases.csv', 'w', newline='') as f:
        w = csv.writer(f); keys = list(cs[0].keys()); w.writerow(keys)
        for c in cs: w.writerow([json.dumps(c[k], sort_keys=True) if isinstance(c[k], (dict, list)) else c[k] for k in keys])
print(len(cases59), len(cases83))
