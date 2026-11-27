#!/bin/sh
# Re-creates the V1 baseline run (engine c3baa5a + harness efa0fc1, seed 0, 500 sellers, synthetic) and dumps the full per-seller inputs and findings for the 28 audited sellers.
# usage: tools/audit-v1.sh <dump-dir>      (about 45 s). Then: python3 tools/audit-v1-cases.py <dump-dir> audit/false-confident-59 audit/duplicates-83
set -eu
OUT=$(realpath -m "$1"); ROOT=$(git rev-parse --show-toplevel); D=$(mktemp -d); mkdir -p "$OUT"
git -C "$ROOT" worktree add -q --detach "$D" c3baa5a; trap 'git -C "$ROOT" worktree remove --force "$D" 2>/dev/null || true' EXIT
git -C "$ROOT" archive efa0fc1 sim | tar -x -C "$D"
python3 - "$D" <<'PY'
import sys
p = sys.argv[1] + '/sim/run.mjs'; s = open(p).read()
hook = "    if (process.env.AUDIT_DIR && (process.env.AUDIT_SELLERS||'').split(',').includes(String(i))) writeFileSync(process.env.AUDIT_DIR + '/seller-' + i + '.json', JSON.stringify({ seller: i, scenario: res.scenario, defects: s.defects, issues: proj.issues, vText, lText, profile: pr.profile, vdecl: vd, ldecl: ld0, txs: s.txs }));\n"
k = "    res.eval = evaluate(s, proj, s.defects);"; assert k in s
open(p, 'w').write(s.replace(k, hook + k, 1))
PY
( cd "$D" && AUDIT_DIR="$OUT" AUDIT_SELLERS=21,56,91,126,161,196,231,266,301,336,371,406,441,476,24,59,94,129,164,199,234,269,304,339,374,409,444,479 node sim/run.mjs 500 "$OUT/v1-results.jsonl" > "$OUT/run.log" 2>&1 )
python3 "$ROOT/tools/v5-fingerprint.py" "$OUT/v1-results.jsonl" /dev/null | grep rowsSha256
