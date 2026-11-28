// Real providers (NOT used by any test, never called in this prototype). They are inert unless DRY_RUN === 'false' AND the secrets exist.
// GitHub: GitHub App installation token (Actions:write, Metadata:read, installed on this one repo), minted per cycle. No PAT.
const API = 'https://api.github.com'; const live = (env) => env.DRY_RUN === 'false';
export function buildProviders(env) {
  const gh = async (path, init = {}, token) => { const r = await fetch(API + path, { ...init, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'invoiceguard-backup-keeper', ...(init.headers ?? {}) } }); if (!r.ok) { const e = new Error(`github ${r.status}`); e.status = r.status; throw e; } return r.status === 204 ? null : r.json(); };
  const appToken = async () => { throw new Error('GitHub App JWT signing is implemented only after the owner creates the App (see README). Prototype: not wired.'); };
  const repo = env.GITHUB_REPO, wf = env.WORKFLOW_FILE ?? 'backup.yml';
  return {
    store: env.DB, clock: () => Date.now(),
    github: {
      listRuns: async () => (await gh(`/repos/${repo}/actions/workflows/${wf}/runs?per_page=20`, {}, await appToken())).workflow_runs,
      listArtifacts: async (runId) => (await gh(`/repos/${repo}/actions/runs/${runId}/artifacts`, {}, await appToken())).artifacts,
      dispatch: async () => { if (!live(env)) throw new Error('dry run'); return gh(`/repos/${repo}/actions/workflows/${wf}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main' }) }, await appToken()); },
    },
    notifier: { send: async ({ title, body, priority }) => { if (!live(env)) return; await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: 'POST', headers: { title, priority }, body }); } },
    heartbeat: { ping: async () => { if (!live(env)) return; await fetch(env.HEALTHCHECKS_URL); } },
  };
}
