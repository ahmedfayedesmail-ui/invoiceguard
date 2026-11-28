import { startServer, signup, vidrOf, startProbe, readSamples, sleep, pct } from './lib.mjs';
import { rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
const SELLERS = +(process.argv[2] ?? 4), ROWS = +(process.argv[3] ?? 3000), OUT = process.argv[4] ?? '/tmp/s2.json';
const dbFile = '/tmp/p2.db'; for (const s of ['', '-wal', '-shm']) rmSync(dbFile + s, { force: true });
const samples = '/tmp/p2-samples.jsonl';
const srv = await startServer({ dbFile, port: 4102, env: { SAMPLES_FILE: samples } });
const base = 'http://127.0.0.1:4102';
const tags = Array.from({ length: SELLERS }, (_, i) => String(500 + i));
const calls = []; for (let i = 0; i < SELLERS; i++) calls.push(await signup(base, `p2-s${i}@x.es`));
const small = await signup(base, 'p2-small@x.es'), probeCall = await signup(base, 'p2-probe@x.es');
// sellers upload at the same instant. Order ids are unique per seller (tag), but ids 1000000.. overlap numerically, and seller 0/1 also share IDENTICAL order ids (same tag) to prove isolation of identical keys.
const sameTag = (i) => i === 1 ? tags[0] : tags[i];
const texts = tags.map((_, i) => vidrOf(ROWS, 1000000, sameTag(i)));
const smallText = vidrOf(50, 1000000, '777');
const writer = spawn(process.execPath, ['--no-warnings', 'proof/writer.mjs', dbFile, process.env.W_HOLD ?? '5', process.env.W_GAP ?? '50'], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'inherit'] }); let wout = ''; writer.stdout.on('data', d => wout += d);
await sleep(500);
const probe = startProbe(probeCall, 50); await sleep(300);
const t0 = Date.now();
const posts = await Promise.all(calls.map((c, i) => c('manual/issue', { text: texts[i], attest: true })));
const smallPost = await new Promise(async ok => { await sleep(200); ok(await small('manual/issue', { text: smallText, attest: true })); }); // small seller arrives 200ms later, behind the big ones
const jobs = [...posts.map((p, i) => ({ who: 'seller' + i, call: calls[i], id: p.body.jobId, postMs: Math.round(p.ms), postStatus: p.status })), { who: 'small(50 rows, arrived +200ms)', call: small, id: smallPost.body.jobId, postMs: Math.round(smallPost.ms), postStatus: smallPost.status }];
const track = jobs.map(j => ({ ...j, firstRunningMs: null, doneMs: null, finalStatus: null, issued: null, held: null, errors: null, monotonic: true, last: -1, pollErrors: 0, polls: [] }));
const crossLeak = { checks: 0, leaked: 0, non404: [] };
while (track.some(j => j.doneMs === null)) {
  for (const j of track) { if (j.doneMs !== null) continue; const r = await j.call('manual/jobs/' + j.id); j.polls.push(r.ms); if (r.status !== 200) { j.pollErrors++; continue; } const b = r.body;
    if (b.status === 'running' && j.firstRunningMs === null) j.firstRunningMs = Date.now() - t0;
    if (b.phase === 'issuing') { if (b.processed < j.last) j.monotonic = false; j.last = b.processed; }
    if (['done', 'error'].includes(b.status)) { j.doneMs = Date.now() - t0; j.finalStatus = b.status; j.issued = b.result?.issued; j.held = b.result?.heldNow; j.errors = b.result?.errors; j.err = b.error; } }
  // cross-tenant poll: every seller asks for every other seller's job id
  for (let a = 0; a < track.length; a += 2) for (const j of track) if (j.call !== track[a].call) { const r = await track[a].call('manual/jobs/' + j.id); crossLeak.checks++; if (r.status !== 404) { crossLeak.leaked++; crossLeak.non404.push(r.status); } }
  await sleep(150); if (Date.now() - t0 > 300000) break; }
console.error('loop done', Date.now() - t0); const total = Date.now() - t0; await sleep(300); const lat = (await probe.stop()).filter(x => x.t >= t0 && x.t <= t0 + total);
writer.kill('SIGTERM'); await sleep(600);
const sm = readSamples(samples).filter(s => s.t >= t0 - 300 && s.t <= t0 + total + 300);
const srvLog = srv.getLog(); srv.kill('SIGTERM'); await sleep(300);
const db = new DatabaseSync(dbFile, { readOnly: true });
const sellers = db.prepare('SELECT id, name FROM sellers').all();
const perSeller = sellers.filter(s => /p2-s\d|small/.test(s.name)).map(s => { const inv = db.prepare("SELECT count(*) c, count(DISTINCT shipment_key) k FROM invoices WHERE seller_id=? AND kind='invoice'").get(s.id); const tagsSeen = db.prepare("SELECT DISTINCT substr(order_id,1,3) t FROM shipments WHERE seller_id=?").all(s.id).map(x => x.t); const js = db.prepare("SELECT json FROM invoices WHERE seller_id=? LIMIT 200").all(s.id); const foreignName = js.filter(x => !JSON.parse(x.json).seller.name.includes(s.name)).length; const nums = db.prepare("SELECT min(number) a, max(number) b FROM invoices WHERE seller_id=? AND kind='invoice'").get(s.id);
  return { seller: s.name.replace('Tienda ', ''), invoices: inv.c, distinctShipments: inv.k, orderTagsInShipments: tagsSeen, invoicesWithOtherSellerName_sampled200: foreignName, numberRange: `${nums.a}..${nums.b}` }; });
const busyInLog = (srvLog.match(/SQLITE_BUSY|database is locked|busy/gi) ?? []).length;
const dups = db.prepare("SELECT count(*) c FROM (SELECT seller_id, shipment_key FROM invoices WHERE kind='invoice' GROUP BY 1,2 HAVING count(*)>1)").get().c;
const dupNumbers = db.prepare("SELECT count(*) c FROM (SELECT seller_id, number FROM invoices GROUP BY 1,2 HAVING count(*)>1)").get().c;
const res = { sellers: SELLERS, rowsEach: ROWS, smallSellerRows: 50, totalWallMs: total,
  jobs: track.map(j => ({ who: j.who, postStatus: j.postStatus, postMs: j.postMs, startedMsAfterT0: j.firstRunningMs, finishedMsAfterT0: j.doneMs, status: j.finalStatus, issued: j.issued, held: j.held, errors: j.errors, error: j.err ?? null, progressMonotonic: j.monotonic, pollFailures: j.pollErrors, statusPollMaxMs: Math.round(Math.max(...j.polls)) })),
  httpProbeOtherSeller: { n: lat.length, p50: Math.round(pct(lat.map(x => x.ms), .5)), p95: Math.round(pct(lat.map(x => x.ms), .95)), p99: Math.round(pct(lat.map(x => x.ms), .99)), max: Math.round(Math.max(...lat.map(x => x.ms))), non200: lat.filter(x => x.status !== 200).length, over500ms: lat.filter(x => x.ms > 500).length },
  inServerLoopLagMaxMs: Math.max(...sm.map(s => s.lagMaxMs)), lagSpikesOver100: sm.filter(s => s.lagMaxMs > 100).map(s => ({ atMs: s.t - t0, lagMs: s.lagMaxMs })), peakRssMB: Math.max(...sm.map(s => s.rssMB)), peakHeapMB: Math.max(...sm.map(s => s.heapMB)),
  contentionWriter: JSON.parse(wout.trim().split('\n').pop() || '{}'), sqliteBusyMentionsInServerLog: busyInLog, serverLogTail: srvLog.split('\n').filter(l => !/ExperimentalWarning|trace-warnings|^UP /.test(l)).slice(-5),
  tenantIsolation: { crossSellerJobPolls: crossLeak, perSeller, duplicateInvoicePerShipment: dups, duplicateInvoiceNumbers: dupNumbers } };
writeFileSync(OUT, JSON.stringify(res, null, 1)); console.log(JSON.stringify(res, null, 1)); process.exit(0);
