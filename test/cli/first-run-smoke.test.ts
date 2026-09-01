import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

function parseFirstJsonObject(output: string): unknown {
  const start = output.indexOf('{');
  assert.notEqual(start, -1, `stdout should include a JSON object:\n${output}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < output.length; i++) {
    const ch = output[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(output.slice(start, i + 1));
    }
  }
  assert.fail(`stdout JSON object was not closed:\n${output}`);
}

describe('first-run smoke path', () => {
  it('runs init -> eval dry-run -> offline eval and writes a report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omk-first-run-smoke-'));
    const project = join(root, 'demo');
    try {
      const init = await execFileAsync('node', [CLI, 'init', project, '--lang', 'zh']);
      assert.match(init.stdout, /直接跑通/);
      assert.match(init.stdout, /看报告里的 verdict/);

      const executor = join(project, 'offline-executor.sh');
      await writeFile(executor, [
        '#!/bin/sh',
        'IFS= read -r request',
        'case "$request" in',
        '  *code-review-v2*) output="SQL injection: use parameterized queries. Handle error status. XSS via innerHTML: use textContent." ;;',
        '  *) output="Looks okay." ;;',
        'esac',
        'printf \'{"schemaVersion":"omk.custom-command-exchange/v1","resultStatus":"completed","output":{"value":"%s","classification":"public"}}\\n\' "$output"',
      ].join('\n'));
      await chmod(executor, 0o755);

      const baseArgs = [
        'eval',
        '--control', 'code-review-v1',
        '--treatment', 'code-review-v2',
        '--executor', executor,
        '--skip-connectivity',
        '--lang', 'zh',
      ];

      const dryRun = await execFileAsync('node', [CLI, ...baseArgs, '--dry-run'], { cwd: project });
      const dryRunReport = parseFirstJsonObject(dryRun.stdout) as {
        projectionKind?: string;
        dataset?: { sampleCount?: number };
        targets?: Array<{ targetId?: string }>;
      };
      assert.equal(dryRunReport.projectionKind, 'core-cli-dry-run');
      assert.equal(dryRunReport.dataset?.sampleCount, 3);
      assert.deepEqual(dryRunReport.targets?.map((target) => target.targetId), ['code-review-v1', 'code-review-v2']);

      const run = await execFileAsync('node', [
        CLI,
        ...baseArgs,
        '--no-judge',
        '--no-diagnostic',
        '--no-serve',
        '--bootstrap-samples', '100',
        '--no-cache',
        '--report-only',
      ], { cwd: project });
      const report = parseFirstJsonObject(run.stdout) as {
        projectionKind?: string;
        runId: string;
        status?: { runStatus?: string };
        usage?: { executionInvocations?: number };
        gate?: { gateStatus?: string };
      };

      assert.equal(report.projectionKind, 'core-cli-run-outcome');
      assert.equal(report.status?.runStatus, 'completed');
      assert.equal(report.usage?.executionInvocations, 6);
      assert.equal(report.gate?.gateStatus, 'skipped');
      const runDirectory = `run-${createHash('sha256').update(report.runId).digest('hex')}`;
      assert.ok(existsSync(join(project, '.omk', 'reports', runDirectory, 'manifest.json')));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
