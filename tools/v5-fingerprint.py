#!/usr/bin/env python3
# Fingerprint of a 500-seller run: sha256 over every seller row with the wall-clock fields removed, plus sha256 of the aggregate without its timing line.
import sys, json, hashlib
TIMING = {'totalMs', 'heapMB', 'projectMs'}
rows = [json.loads(l) for l in open(sys.argv[1])]
rows.sort(key=lambda r: r['seller'])
h = hashlib.sha256()
for r in rows: h.update(json.dumps({k: v for k, v in r.items() if k not in TIMING}, sort_keys=True, separators=(',', ':')).encode())
agg = ''.join(l for l in open(sys.argv[2]) if 'projection ms' not in l)
print(json.dumps({'sellers': len(rows), 'rowsSha256': h.hexdigest(), 'aggregateSha256': hashlib.sha256(agg.encode()).hexdigest(), 'ignoredFields': sorted(TIMING), 'ignoredAggregateLine': 'projection ms'}, indent=1))
