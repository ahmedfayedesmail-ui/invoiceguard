// Local CPU indicator ONLY. Cloudflare enforces the 10 ms CPU limit on its own runtime; this measures node CPU time of one cycle with mocks and an in-memory SQLite, which excludes network time (not CPU) and the real fetch/TLS cost.
import { runCycle } from './worker.js'; import { d1, mocks, deps, run, H, T0 } from './test/helpers.js';
const N = 200; const times = [];
for (let i = 0; i < N + 20; i++) { const s = d1(), m = mocks({ runs: [run(2, 'completed', 'failure', T0 - 60e3), run(1, 'completed', 'success', T0 - 9 * H)] }); const c0 = process.cpuUsage(); await runCycle(deps(m, s)); const c = process.cpuUsage(c0); if (i >= 20) times.push((c.user + c.system) / 1000); }
times.sort((a, b) => a - b); console.log(JSON.stringify({ cycles: N, cpuMs: { p50: times[N / 2 | 0], p95: times[N * .95 | 0], max: times[N - 1] }, note: 'node CPU ms incl. in-memory db setup per cycle; indicator only, not Cloudflare CPU' }));
