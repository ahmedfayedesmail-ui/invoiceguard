# Readiness scorecard (honest, self-assessed by the implementing agent; to be revised after the independent review)
| Gate | Status | Evidence | Gap |
|---|---|---|---|
| 1 Financial correctness | Met for known paths | invariants + model-based walks + hold triggers | no real Amazon data |
| 2 Amazon integration integrity | Partly | identity check on all statuses | real rows unseen, sign convention unknown |
| 3 State integrity | Met locally | terminal trigger, transition table | odd transitions undecided |
| 4 Concurrency | Met for tested races | two-process tests, triggers | not exhaustive |
| 5 Evidence | Met | evidence snapshot, decisions with user and reason | |
| 6 Security | Not assessed beyond the new routes | seller scoping tests | app auth not reviewed |
| 7 Reliability | Partly | recovery tests exist | no real reboot test |
| 8 Usability | API explanation only | /api/holds fields, demo | no screen |
| 9 Operability | Met locally | npm run demo, docs | |
| 10 Independent verification | IN PROGRESS | 4 real reviewers launched, IDs in registry.json | reports pending |
Not production-proven. Production claims need a complete real-seller cycle.
