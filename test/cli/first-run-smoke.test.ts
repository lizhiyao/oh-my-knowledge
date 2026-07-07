import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

      await writeFile(join(project, 'offline-executor.mjs'), [
        'import { readFileSync } from "node:fs";',
        'const req = JSON.parse(readFileSync(0, "utf8"));',
        'const isV2 = req.system.includes("高级代码审查专家");',
        'const output = isV2',
        '  ? "SQL injection: use parameterized queries. Handle error status. XSS via innerHTML: use textContent."',
        '  : "Looks okay."; ',
        'console.log(JSON.stringify({ output, durationApiMs: 0, inputTokens: 1, outputTokens: 1 }));',
      ].join('\n'));

      const baseArgs = [
        'eval',
        '--control', 'code-review-v1',
        '--treatment', 'code-review-v2',
        '--executor', 'node offline-executor.mjs',
        '--skip-connectivity',
        '--lang', 'zh',
      ];

      const dryRun = await execFileAsync('node', [CLI, ...baseArgs, '--dry-run'], { cwd: project });
      const dryRunReport = parseFirstJsonObject(dryRun.stdout) as { dryRun?: boolean; totalTasks?: number; variants?: string[] };
      assert.equal(dryRunReport.dryRun, true);
      assert.equal(dryRunReport.totalTasks, 6);
      assert.deepEqual(dryRunReport.variants, ['code-review-v1', 'code-review-v2']);
      assert.match(dryRun.stdout, /eval dry-run：仅预览任务，不检查分数/);

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
        id: string;
        kind?: string;
        meta?: { variants?: string[]; sampleCount?: number };
        summary?: Record<string, { avgCompositeScore?: number }>;
        results?: unknown[];
      };

      assert.equal(report.kind, 'evaluation');
      assert.deepEqual(report.meta?.variants, ['code-review-v1', 'code-review-v2']);
      assert.equal(report.meta?.sampleCount, 3);
      assert.equal(report.results?.length, 3);
      assert.ok(
        (report.summary?.['code-review-v2']?.avgCompositeScore ?? 0)
        > (report.summary?.['code-review-v1']?.avgCompositeScore ?? 0),
        'v2 should score higher than the starter v1 in the offline smoke executor',
      );
      assert.match(run.stderr, /判定：/);
      assert.match(run.stderr, /下一步：/);
      assert.ok(existsSync(join(project, '.omk', 'reports', `${report.id}.report.json`)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
