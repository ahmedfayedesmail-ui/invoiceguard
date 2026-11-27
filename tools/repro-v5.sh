#!/bin/sh
# Reproduce the 500-seller V5 run from a CLEAN checkout of a named engine SHA, with the harness pinned at 287b17e (sim/v3-forensics, the commit that published V5).
# usage: tools/repro-v5.sh <engine-sha> <out-dir>      (about 50 s; synthetic data only; deterministic apart from timings, which the fingerprint ignores)
set -eu
SHA=$(git rev-parse "$1"); OUT=$(realpath -m "$2"); HARNESS=287b17e; ROOT=$(git rev-parse --show-toplevel); D=$(mktemp -d)
git -C "$ROOT" worktree add -q --detach "$D" "$SHA"
trap 'git -C "$ROOT" worktree remove --force "$D" 2>/dev/null || true' EXIT
git -C "$ROOT" archive "$HARNESS" sim | tar -x -C "$D"
mkdir -p "$OUT"; ( cd "$D" && node sim/run.mjs 500 "$OUT/results.jsonl" > "$OUT/run.log" 2>&1 )
python3 "$D/sim/aggregate.py" "$OUT/results.jsonl" > "$OUT/aggregate.full.txt"
grep -v 'projection ms' "$OUT/aggregate.full.txt" > "$OUT/aggregate.txt"
python3 "$ROOT/tools/v5-fingerprint.py" "$OUT/results.jsonl" "$OUT/aggregate.full.txt" > "$OUT/fingerprint.json"
printf '%s\n' "engine $SHA" "harness $HARNESS" "git status of the checkout: $(git -C "$D" status --porcelain | grep -v '^?? sim/$' | wc -l) modified tracked files" > "$OUT/provenance.txt"
