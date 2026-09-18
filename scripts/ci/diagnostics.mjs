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

function readText(path) {
  try { return readFileSync(path, 'utf8').trim(); } catch { return null; }
}

/**
 * 崩溃现场：进程被信号杀死时，最后能说话的是内核与压力曲线。OOM killer 只出现在 dmesg；
 * runner 上 dmesg 受限时用免密 sudo，拿不到就如实记原因——诊断永不反过来搞挂构建。
 */
function capturePostmortem(directory, name, attempt) {
  const sections = [];
  for (const kind of ['memory', 'cpu', 'io']) {
    sections.push(`== /proc/pressure/${kind} ==\n${readText(`/proc/pressure/${kind}`) ?? 'unavailable'}`);
  }
  let dmesg = 'unavailable';
  if (process.platform === 'linux') {
    for (const cmd of [['dmesg', '--ctime'], ['sudo', '-n', 'dmesg', '--ctime']]) {
      const out = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      if (!out.error && out.status === 0 && out.stdout) { dmesg = out.stdout.split('\n').slice(-80).join('\n'); break; }
      dmesg = `unavailable (${out.error?.code ?? `exit ${out.status}`})`;
    }
  }
  sections.push(`== dmesg (tail 80) ==\n${dmesg}`);
  appendFileSync(join(directory, `${name}-postmortem.txt`), `\n### attempt ${attempt} @ ${new Date().toISOString()}\n${sections.join('\n\n')}\n`);
}

/**
 * 限时运行一条命令并留证。`retryOn` 里列出的失败类别（如 unknown_signal：进程被信号杀死但
 * 没有 OOM 证据）允许整体重跑一次——瞬态崩溃不该靠手工 rerun 消红。时限跨尝试共享：
 * 重试拿的是剩余预算，剩余不足预算的 10%（且至少 5s）时不重试，如实按首次失败报告。
 */
export async function runBounded({ name, directory, timeoutMs, command, graceMs = 5000, sampleMs = 10000, retryOn = [] }) {
  if (!/^[a-z0-9-]+$/.test(name) || !directory || !(timeoutMs > 0) || !command.length) throw new Error('Invalid bounded command');
  mkdirSync(directory, { recursive: true });
  const startedAt = new Date().toISOString(); const start = performance.now();
  const initialOom = oomCount();
  const log = join(directory, `${name}.log`);
  writeFileSync(log, '');
  let cancelled = false;
  const sampler = setInterval(sample, sampleMs);
  function sample() {
    const processes = spawnSync('ps', ['-eo', 'pid,ppid,rss,stat,comm'], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 });
    appendFileSync(join(directory, `${name}-resources.jsonl`), JSON.stringify({ at: new Date().toISOString(),
      freeMemory: freemem(), totalMemory: totalmem(), oomKills: oomCount(), processes: processes.stdout?.slice(0, 128000) ?? 'unavailable' }) + '\n');
  }
  sample();

  const attemptLog = [];
  async function attempt(attemptNo) {
    const remaining = timeoutMs - (performance.now() - start);
    let tail = ''; let logged = 0; let timedOut = false; let spawnError;
    appendFileSync(log, `\n===== attempt ${attemptNo} =====\n`);
    const child = spawn(command[0], command.slice(1), { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = (signal) => { try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); } catch { /* already exited */ } };
    let escalation;
    const stop = () => { kill('SIGTERM'); escalation ??= setTimeout(() => kill('SIGKILL'), graceMs); };
    const cancel = () => { cancelled = true; stop(); };
    process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
    const deadline = setTimeout(() => { timedOut = true; sample(); stop(); }, remaining);
    const consume = (stream) => (chunk) => {
      stream.write(chunk); tail = (tail + chunk.toString()).slice(-65536);
      if (logged < 16 * 1024 * 1024) { appendFileSync(log, chunk); logged += chunk.length; }
    };
    child.stdout.on('data', consume(process.stdout)); child.stderr.on('data', consume(process.stderr));
    child.on('error', error => { spawnError = error.code ?? 'spawn failed'; });
    const attemptStart = performance.now();
    const result = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
    clearTimeout(deadline); clearTimeout(escalation);
    kill('SIGKILL'); // Reap surviving descendants even after a successful parent exit.
    process.off('SIGTERM', cancel); process.off('SIGINT', cancel);
    const category = failureCategory({ ...result, timedOut, cancelled, spawnError, tail, oomKilled: oomCount() > initialOom });
    const entry = { attempt: attemptNo, ...result, category, durationMs: Math.round(performance.now() - attemptStart) };
    attemptLog.push(entry);
    if (category !== 'success' && category !== 'cancelled') capturePostmortem(directory, name, attemptNo);
    return entry;
  }

  let final = await attempt(1);
  const remainingAfterFirst = timeoutMs - (performance.now() - start);
  const retryFloorMs = Math.max(5000, timeoutMs * 0.1);
  if (retryOn.includes(final.category) && !cancelled && remainingAfterFirst > retryFloorMs) {
    console.log(`\n[${name}] ${final.category} → 剩余预算 ${Math.round(remainingAfterFirst / 1000)}s，整体重试一次`);
    final = await attempt(2);
  }
  clearInterval(sampler);

  const record = { name, startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start),
    code: final.code, signal: final.signal, category: final.category,
    attempts: attemptLog.length, ...(attemptLog.length > 1 ? { attemptLog } : {}) };
  writeFileSync(join(directory, `${name}.json`), JSON.stringify(record, null, 2));
  console.log(`\n[${name}] ${record.category} (${record.durationMs} ms, attempts ${attemptLog.length})`);
  return record.category === 'success' ? 0 : cancelled ? 130 : final.category === 'process_timeout' ? 124 : final.code || 1;
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
    const rows = records.map(r => `| ${String(r.name).replaceAll('|', '/')} | ${r.category}${(r.attempts ?? 1) > 1 ? ` (${r.attempts} attempts)` : ''} | ${r.durationMs === null ? 'unknown' : Math.round(r.durationMs / 1000)} |`).join('\n');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### CI/CD diagnostics\n\n| Stage | Outcome | Seconds |\n|---|---|---|\n${rows || '| unavailable | No completed diagnostic record | — |'}\n\n${summary.limitation}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === 'report') reportDiagnostics(args[0]);
  else if (operation === 'run') {
    const [name, directory, timeout, ...rest] = args;
    const retryOn = [];
    while (rest[0]?.startsWith('--retry-on=')) retryOn.push(...rest.shift().slice('--retry-on='.length).split(',').filter(Boolean));
    process.exitCode = await runBounded({ name, directory, timeoutMs: Number(timeout), command: rest, retryOn });
  } else throw new Error('Usage: diagnostics.mjs <run NAME DIR TIMEOUT_MS [--retry-on=cat,...] COMMAND...|report DIR>');
}
