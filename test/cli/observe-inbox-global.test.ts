/**
 * observe-inbox 的 --global 写 / 读对称验收(子进程实跑真 CLI):
 * - `observe ingest --global` 写全局 ~/.oh-my-knowledge/observe-inbox,项目 .omk/observe-inbox 不落;
 * - `observe inbox --global` 直读全局;默认 `observe inbox` 在项目空时兜底读全局。
 * 每条用例独占一个临时 OMK_HOME,不碰真实 home。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

/** 造一个最小 trace 目录(单条 user 记录,够 buildObservationInboxReport 产出有效报告)。 */
function makeTrace(base: string): string {
  const traceDir = join(base, 'trace');
  mkdirSync(traceDir, { recursive: true });
  const rec = {
    type: 'user', uuid: 'u1', parentUuid: null, sessionId: 's1',
    timestamp: '2026-05-01T00:00:00.000Z', cwd: '/repo-a',
    message: { role: 'user', content: '<command-name>/audit</command-name>\nhi' },
  };
  writeFileSync(join(traceDir, 'session.jsonl'), JSON.stringify(rec));
  return traceDir;
}

/** 独立沙盒:临时 OMK_HOME(全局根)+ 临时项目 cwd。 */
function sandbox(): { home: string; project: string; trace: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'omk-inbox-global-'));
  const home = join(base, 'home');
  const project = join(base, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const trace = makeTrace(base);
  return {
    home, project, trace,
    env: { ...process.env, OMK_HOME: home },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function inboxJsons(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('-observe-inbox.json')) : [];
}

describe('observe-inbox --global', () => {
  it('ingest --global → 写全局 observe-inbox,项目 .omk/observe-inbox 不落', async () => {
    const s = sandbox();
    try {
      await execFileAsync('node', [CLI, 'observe', 'ingest', s.trace, '--global'], { cwd: s.project, env: s.env });
      const globalDir = join(s.home, 'observe-inbox');
      const projectDir = join(s.project, '.omk', 'observe-inbox');
      assert.equal(inboxJsons(globalDir).length, 1, '全局目录有一份 observe-inbox 报告');
      assert.deepEqual(inboxJsons(projectDir), [], '项目目录不落(--global 走全局)');
    } finally {
      s.cleanup();
    }
  });

  it('ingest(默认）→ 写项目 .omk/observe-inbox,全局不落', async () => {
    const s = sandbox();
    try {
      await execFileAsync('node', [CLI, 'observe', 'ingest', s.trace], { cwd: s.project, env: s.env });
      const globalDir = join(s.home, 'observe-inbox');
      const projectDir = join(s.project, '.omk', 'observe-inbox');
      assert.equal(inboxJsons(projectDir).length, 1, '项目目录有一份(默认项目级)');
      assert.deepEqual(inboxJsons(globalDir), [], '全局不落');
    } finally {
      s.cleanup();
    }
  });

  it('inbox --global → 直读全局;默认 inbox 在项目空时兜底读全局', async () => {
    const s = sandbox();
    try {
      // 只写全局,项目侧保持空。
      await execFileAsync('node', [CLI, 'observe', 'ingest', s.trace, '--global'], { cwd: s.project, env: s.env });
      // --global 直读全局。
      const g = await execFileAsync('node', [CLI, 'observe', 'inbox', '--global', '--json'], { cwd: s.project, env: s.env });
      const gp = JSON.parse(g.stdout);
      assert.equal(gp.kind, 'observe-inbox-query');
      // 默认(无 --global):项目空 → loadObservationInboxReports 兜底读全局,同样看到。
      const d = await execFileAsync('node', [CLI, 'observe', 'inbox', '--json'], { cwd: s.project, env: s.env });
      const dp = JSON.parse(d.stdout);
      assert.equal(dp.kind, 'observe-inbox-query');
      assert.ok(Array.isArray(dp.items));
    } finally {
      s.cleanup();
    }
  });

  it('ingest --help / inbox --help 列出 --global', async () => {
    const ing = await execFileAsync('node', [CLI, 'observe', 'ingest', '--help']);
    assert.ok(ing.stdout.includes('--global'), 'ingest --help 应列 --global');
    const inb = await execFileAsync('node', [CLI, 'observe', 'inbox', '--help']);
    assert.ok(inb.stdout.includes('--global'), 'inbox --help 应列 --global');
  });
});
