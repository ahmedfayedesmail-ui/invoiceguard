# HTTP-layer load audit (squad swarm-api-load)

Synthetic-data, temp-database HTTP measurements. Tooling only: no application code is changed by this directory.

- `server.mjs` boots the real app from `APP_ROOT` on a file DB, with a stub VAT validator and an event-loop lag probe (SIGUSR2 prints STATS).
- `gen.mjs` generates synthetic Amazon Order Reports and VAT Invoice Data Reports (VIDR).
- `run-base.mjs` measures manual preview/issue concurrency, the 6 MB body cap boundary, malformed requests, rate limits, the in-flight cap and memory under concurrent uploads (base branch ebfd583).
- `run-intel.mjs`, `probe5.mjs` measure `/api/intel/seal`, `/api/intel/timeline` and `/api/intel/export` under load (PR #5 head d1466ff, read-only clone).

Usage: `node run-base.mjs <phase>` or `node run-intel.mjs <phase>`; each run creates a fresh /tmp database.
