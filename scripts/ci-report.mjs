import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.argv[2];
if (!directory) throw new Error('Explicit diagnostics directory required');
mkdirSync(directory, { recursive: true });
const records = readdirSync(directory).filter(name => name.endsWith('.json') && name !== 'summary.json').flatMap(name => {
  try { const record = JSON.parse(readFileSync(join(directory, name), 'utf8')); return record.category ? [record] : []; }
  catch { return []; }
});
for (const name of readdirSync(directory).filter(name => name.endsWith('-resources.jsonl'))) {
  const stage = name.slice(0, -'-resources.jsonl'.length);
  if (!records.some(record => record.name === stage)) records.push({ name: stage, category: 'incomplete', durationMs: null });
}
const counts = {};
for (const { category } of records) counts[category] = (counts[category] ?? 0) + 1;
const summary = { workflow: process.env.GITHUB_WORKFLOW, runId: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT, job: process.env.GITHUB_JOB, jobStatus: process.env.CI_JOB_STATUS ?? 'unknown', counts, records,
  limitation: 'Runner loss or job-level termination can prevent final diagnostics; absent evidence is not OOM.' };
writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
if (process.env.GITHUB_STEP_SUMMARY && existsSync(directory)) {
  const rows = records.map(r => `| ${String(r.name).replaceAll('|', '/')} | ${r.category} | ${r.durationMs === null ? 'unknown' : Math.round(r.durationMs / 1000)} |`).join('\n');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### CI/CD diagnostics\n\n| Stage | Outcome | Seconds |\n|---|---|---|\n${rows || '| unavailable | No completed diagnostic record | — |'}\n\n${summary.limitation}\n`);
}
