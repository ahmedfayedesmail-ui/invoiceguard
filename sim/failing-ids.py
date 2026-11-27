"""Seller ids per failure category, computed from a results file. usage: python3 sim/failing-ids.py results.jsonl > sim/out/failing-ids.json"""
import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1])]
out = collections.defaultdict(list)
for r in rows:
    s = r['seller']; ev = r.get('eval') or {}; c = r.get('conf')
    if r.get('mapping') and 'error' not in r['mapping'] and not r['mapping'].get('auto'): out['onboarding_manual_mapping'].append(s)
    if r.get('outcome') in ('blocked_mapping', 'blocked_kind_words'): out['onboarding_blocked'].append(s)
    for m in ev.get('missed', []): out['missed__' + m].append(s)
    if c:
        if c['commercial']['conflictingEvidence']: out['confident_on_conflicting_evidence'].append(s)
        if c['commercial']['false']: out['confident_false_commercial'].append(s)
        if c['commercial']['declarationDependent']: out['declaration_dependent_findings'].append(s)
        if c['source']['unexpected']: out['source_incomplete_unexpected'].append(s)
    if r.get('cohort') == 'monthly_export' and ev.get('detected', 0) < ev.get('defects', 0): out['partial_coverage_gaps_unreported'].append(s)
    r2 = r.get('round2') or {}
    if r2.get('closedWrong') and r['scenario'] != 'follow_up_stale_report': out['round2_closed_wrong'].append(s)
    if r2.get('stillOpenWrong'): out['round2_still_open_wrong'].append(s)
print(json.dumps({k: sorted(set(v)) for k, v in sorted(out.items())}))
