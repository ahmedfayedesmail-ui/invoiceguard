// Poll a background manual-issue job (api-load F1) until it finishes; returns { status, body }
// shaped like the pre-async /api/manual/issue response, so tests assert the same payloads.
export async function issueAndWait(call, body, { timeoutMs = 120000 } = {}) {
  const r = await call('manual/issue', body);
  if (r.status !== 202) return r;
  const t0 = Date.now();
  for (;;) {
    await new Promise(r2 => setTimeout(r2, 50));
    const j = await call('manual/jobs/' + r.body.jobId);
    if (j.status === 200 && (j.body.status === 'done' || j.body.status === 'error')) return { status: j.body.httpStatus ?? (j.body.status === 'done' ? 200 : 500), body: j.body.result };
    if (Date.now() - t0 > timeoutMs) throw new Error('job did not finish in time: ' + JSON.stringify(j.body));
  }
}
