import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function readJSON(url, { token, fetcher = fetch, wait = sleep } = {}) {
  // Only GETs retry. Tests, installation, builds and publication never retry automatically.
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
      if (response.status === 404) return null;
      if (!response.ok) {
        const error = new Error(`Read-only request returned HTTP ${response.status}`);
        error.transient = [408, 429, 500, 502, 503, 504].includes(response.status); throw error;
      }
      return await response.json();
    } catch (error) {
      const transient = error.transient === true || ['TimeoutError', 'AbortError'].includes(error.name)
        || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.cause?.code);
      if (!transient || attempt >= 2) {
        if (transient) {
          const failure = new Error(error.message); failure.name = 'ReadNetworkError'; throw failure;
        }
        throw error;
      }
      console.log(`[read-only retry] transient network failure; retry ${attempt + 1}/2`);
      await wait((attempt + 1) * 1000);
    }
  }
}

export function fullCI(run, jobs, { sha, repository, workflowId }) {
  if (run.head_sha !== sha || run.repository?.full_name !== repository || run.workflow_id !== workflowId
    || run.status !== 'completed' || run.conclusion !== 'success'
    || !(run.event === 'push' && run.head_branch === 'main' || run.event === 'workflow_dispatch')) return false;
  const required = ['quality', 'test (22)', 'test (24)', ...['22', '24'].flatMap(version =>
    [1, 2, 3, 4].map(shard => `test shard (${version}, ${shard}/4)`))];
  return required.every(name => jobs.some(job => job.name === name && job.status === 'completed' && job.conclusion === 'success'));
}

export async function findEvidence({ repository, sha, read, wait = sleep, timeoutMs = 600000 }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid release identity');
  const base = `https://api.github.com/repos/${repository}`;
  const workflow = await read(`${base}/actions/workflows/ci.yml`);
  if (!workflow?.id) throw new Error('CI workflow is unavailable');
  const end = Date.now() + timeoutMs;
  do {
    const result = await read(`${base}/actions/workflows/${workflow.id}/runs?head_sha=${sha}&per_page=100`);
    const candidates = (result?.workflow_runs ?? []).filter(run => run.head_sha === sha
      && (run.event === 'push' && run.head_branch === 'main' || run.event === 'workflow_dispatch'))
      .sort((a, b) => b.id - a.id);
    const run = candidates[0];
    if (run?.status === 'completed') {
      const jobs = []; let page = 1;
      for (;;) {
        const data = await read(`${base}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page++}`);
        if (!Array.isArray(data?.jobs)) throw new Error('CI job evidence is unavailable');
        jobs.push(...data.jobs); if (data.jobs.length < 100) break;
        if (page > 20) throw new Error('CI job evidence exceeds capacity');
      }
      if (!fullCI(run, jobs, { repository, sha, workflowId: workflow.id })) {
        throw new Error('Exact-commit CI failed or lacks the full Node 22/24 matrix. Run CI via workflow_dispatch on the release tag; do not move the tag.');
      }
      return { commit: sha, runId: run.id, attempt: run.run_attempt, url: run.html_url, workflowId: workflow.id };
    }
    if (Date.now() >= end) break;
    console.log('Waiting for full CI on the exact release commit…'); await wait(Math.min(15000, end - Date.now()));
  } while (Date.now() <= end);
  throw new Error('Exact-commit CI did not finish within the wait budget. Complete full CI before retrying release validation.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2]; if (!directory) throw new Error('Explicit output directory required');
  mkdirSync(directory, { recursive: true });
  const evidence = await findEvidence({ repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA,
    read: url => readJSON(url, { token: process.env.GH_TOKEN }) });
  writeFileSync(join(directory, 'ci-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`Reusing full CI: ${evidence.url}`);
}
