import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function failureCategory({ code, signal, timedOut, cancelled, oomKilled, tail = '', spawnError }) {
  if (cancelled) return 'cancelled';
  if (code === 0 && !signal && !timedOut && !spawnError) return 'success';
  if (oomKilled || /FATAL ERROR:.*heap|JavaScript heap out of memory/i.test(tail)) return 'out_of_memory';
  if (timedOut) return 'process_timeout';
  if (spawnError) return 'execution_failure';
  if (/ReadNetworkError:|npm error code (ECONNRESET|ETIMEDOUT|EAI_AGAIN)/.test(tail)) return 'network_failure';
  if (signal) return 'unknown_signal'; // SIGKILL alone does not establish OOM.
  return code === 0 ? 'success' : 'command_failure';
}

function oomCount() {
  try { return Number(readFileSync('/sys/fs/cgroup/memory.events', 'utf8').match(/^oom_kill (\d+)$/m)?.[1] ?? 0); }
  catch { return 0; }
}

export async function runBounded({ name, directory, timeoutMs, command, graceMs = 5000, sampleMs = 10000 }) {
  if (!/^[a-z0-9-]+$/.test(name) || !directory || !(timeoutMs > 0) || !command.length) throw new Error('Invalid bounded command');
  mkdirSync(directory, { recursive: true });
  const startedAt = new Date().toISOString(); const start = performance.now(); const initialOom = oomCount();
  let tail = ''; let logged = 0; let timedOut = false; let cancelled = false; let spawnError;
  const log = join(directory, `${name}.log`);
  writeFileSync(log, '');
  const child = spawn(command[0], command.slice(1), { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = (signal) => { try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); } catch { /* already exited */ } };
  let escalation;
  const stop = () => { kill('SIGTERM'); escalation ??= setTimeout(() => kill('SIGKILL'), graceMs); };
  const cancel = () => { cancelled = true; stop(); };
  process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
  const sample = () => {
    const processes = spawnSync('ps', ['-eo', 'pid,ppid,rss,stat,comm'], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 });
    appendFileSync(join(directory, `${name}-resources.jsonl`), JSON.stringify({ at: new Date().toISOString(),
      freeMemory: freemem(), totalMemory: totalmem(), oomKills: oomCount(), processes: processes.stdout?.slice(0, 128000) ?? 'unavailable' }) + '\n');
  };
  sample(); const sampler = setInterval(sample, sampleMs);
  const deadline = setTimeout(() => { timedOut = true; sample(); stop(); }, timeoutMs);
  const consume = (stream) => (chunk) => {
    stream.write(chunk); tail = (tail + chunk.toString()).slice(-65536);
    if (logged < 16 * 1024 * 1024) { appendFileSync(log, chunk); logged += chunk.length; }
  };
  child.stdout.on('data', consume(process.stdout)); child.stderr.on('data', consume(process.stderr));
  child.on('error', error => { spawnError = error.code ?? 'spawn failed'; });
  const result = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(deadline); clearTimeout(escalation); clearInterval(sampler);
  kill('SIGKILL'); // Reap surviving descendants even after a successful parent exit.
  process.off('SIGTERM', cancel); process.off('SIGINT', cancel);
  const category = failureCategory({ ...result, timedOut, cancelled, spawnError, tail, oomKilled: oomCount() > initialOom });
  const record = { name, startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start),
    ...result, category, ...(spawnError ? { spawnError } : {}), attempts: 1 };
  writeFileSync(join(directory, `${name}.json`), JSON.stringify(record, null, 2));
  console.log(`\n[${name}] ${category} (${record.durationMs} ms)`);
  return category === 'success' ? 0 : cancelled ? 130 : timedOut ? 124 : result.code || 1;
}

export function reportDiagnostics(directory) {
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === 'report') reportDiagnostics(args[0]);
  else if (operation === 'run') {
    const [name, directory, timeout, ...command] = args;
    process.exitCode = await runBounded({ name, directory, timeoutMs: Number(timeout), command });
  } else throw new Error('Usage: diagnostics.mjs <run NAME DIR TIMEOUT_MS COMMAND...|report DIR>');
}
