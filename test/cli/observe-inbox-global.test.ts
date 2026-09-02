/**
 * observe-inbox 的 --global 写 / 读对称验收,覆盖 ingest / inbox / show:
 * - ingest --global 写全局、默认写项目,两者互斥;
 * - inbox --global 钉死全局(用可区分内容证明:不串项目),默认项目优先、项目缺失才兜底全局;
 * - 显式 --output-dir / --input-dir 胜过 --global;
 * - show --global 顺着 inbox --global 的 id 读到全局那条(项目非空时默认 show 读不到,证明闭环已补)。
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
import { isReportFileName } from '../../src/measurement-artifacts/file-names.js';
import ObserveInbox from '../../src/cli/commands/observe/inbox.js';
import ObserveIngest from '../../src/cli/commands/observe/ingest.js';
import {
  buildObservationInboxReport,
  saveObservationInboxReport,
} from '../../src/observability/inbox/index.js';
import { runCommand } from '../helpers/run-command.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

interface ExecError extends Error { code?: number; stdout: string; stderr: string; }

/** 造一个 trace 目录,产出一条 hard_miss item(skillName = `skill`),让 global / project 内容可区分。 */
function makeTrace(dir: string, skill: string): string {
  mkdirSync(dir, { recursive: true });
  const records = [
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 's1', timestamp: '2026-05-01T00:00:00.000Z', cwd: '/repo-a',
      message: { role: 'user', content: `<command-name>/${skill}</command-name>\nFind revenue schema` } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 's1', timestamp: '2026-05-01T00:00:01.000Z', cwd: '/repo-a',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'revenue_schema', path: '/repo-a' } }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: 's1', timestamp: '2026-05-01T00:00:02.000Z', cwd: '/repo-a',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'No matches found', is_error: false }] } },
  ];
  writeFileSync(join(dir, 'session.jsonl'), records.map((r) => JSON.stringify(r)).join('\n'));
  return dir;
}

function box(): { home: string; project: string; base: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'omk-inbox-global-'));
  const home = join(base, 'home');
  const project = join(base, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { home, project, base, env: { ...process.env, OMK_HOME: home }, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function inboxJsons(dir: string): string[] {
  const reportsDir = existsSync(join(dir, 'reports')) ? join(dir, 'reports') : dir;
  return existsSync(reportsDir) ? readdirSync(reportsDir).filter(isReportFileName) : [];
}

function seedInbox(traceDir: string, skill: string, inboxDir: string): void {
  const report = buildObservationInboxReport(makeTrace(traceDir, skill));
  saveObservationInboxReport(report, inboxDir);
}

const globalInbox = (home: string): string => join(home, 'observe', 'inbox');
const projectInbox = (project: string): string => join(project, '.omk', 'observe', 'inbox');

async function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('node', [CLI, ...args], { cwd, env });
  return stdout;
}
function skillNames(jsonStdout: string): string[] {
  const parsed = JSON.parse(jsonStdout);
  return (parsed.items as Array<{ skillName: string }>).map((i) => i.skillName);
}

describe('observe-inbox --global', () => {
  it('ingest --global → 写全局,项目不落;ingest 默认 → 写项目,全局不落', async () => {
    const s = box();
    try {
      await cli(['observe', 'ingest', makeTrace(join(s.base, 'tg'), 'gskill'), '--global'], s.project, s.env);
      assert.equal(inboxJsons(globalInbox(s.home)).length, 1, '--global 写全局');
      assert.deepEqual(inboxJsons(projectInbox(s.project)), [], '--global 不落项目');

      await cli(['observe', 'ingest', makeTrace(join(s.base, 'tp'), 'pskill')], s.project, s.env);
      assert.equal(inboxJsons(projectInbox(s.project)).length, 1, '默认写项目');
      assert.equal(inboxJsons(globalInbox(s.home)).length, 1, '默认写项目时不新增全局报告');
    } finally { s.cleanup(); }
  });

  it('inbox / show --global 钉死全局，默认读项目且不串数据', async () => {
    const s = box();
    try {
      seedInbox(join(s.base, 'tg'), 'gskill', globalInbox(s.home));
      seedInbox(join(s.base, 'tp'), 'pskill', projectInbox(s.project));

      const globalOutput = await cli(['observe', 'inbox', '--global', '--json'], s.project, s.env);
      const g = skillNames(globalOutput);
      assert.ok(g.length > 0, '--global 读到非空');
      assert.ok(g.includes('gskill'), '--global 含全局那条');
      assert.ok(!g.includes('pskill'), '--global 不串项目数据');

      const d = skillNames(await cli(['observe', 'inbox', '--json'], s.project, s.env));
      assert.ok(d.length > 0, '默认读到非空');
      assert.ok(d.includes('pskill'), '默认含项目那条');
      assert.ok(!d.includes('gskill'), '项目非空时默认不串全局');

      const items = JSON.parse(globalOutput).items as Array<{ id: string; skillName: string }>;
      const gid = items.find((item) => item.skillName === 'gskill')?.id;
      assert.ok(gid, '从 inbox --global 拿到全局那条的 id');
      assert.ok((await cli(['observe', 'show', gid, '--global'], s.project, s.env)).length > 0, 'show --global 读到全局详情');

      try {
        await cli(['observe', 'show', gid], s.project, s.env);
        assert.fail('预期默认 show 找不到全局 id 而非零退出');
      } catch (err) {
        assert.equal((err as ExecError).code, 1, '默认 show 找不到 → exit 1');
      }
    } finally { s.cleanup(); }
  });

  it('inbox 默认在项目目录缺失时兜底读全局', async () => {
    const s = box();
    try {
      seedInbox(join(s.base, 'tg'), 'gskill', globalInbox(s.home));
      // 项目从未写过 → .omk/observe/inbox 不存在 → loadObservationInboxReports 兜底全局。
      assert.ok(!existsSync(projectInbox(s.project)), '前提:项目 inbox 目录不存在');
      const d = skillNames(await cli(['observe', 'inbox', '--json'], s.project, s.env));
      assert.ok(d.includes('gskill'), '默认兜底读到全局');
    } finally { s.cleanup(); }
  });

  it('显式 --output-dir / --input-dir 胜过 --global', async () => {
    const s = box();
    try {
      const explicit = join(s.base, 'explicit');
      await runCommand(ObserveIngest, [makeTrace(join(s.base, 'tx'), 'xskill'), '--output-dir', explicit, '--global'], {
        cwd: s.project,
        env: s.env,
      });
      assert.equal(inboxJsons(explicit).length, 1, '--output-dir 胜过 --global,落显式目录');
      assert.deepEqual(inboxJsons(globalInbox(s.home)), [], '--global 被 --output-dir 压住,全局不落');

      const result = await runCommand(ObserveInbox, ['--input-dir', explicit, '--global', '--json'], {
        cwd: s.project,
        env: s.env,
      });
      const r = skillNames(result.stdout);
      assert.ok(r.includes('xskill'), '--input-dir 胜过 --global,读显式目录');
    } finally { s.cleanup(); }
  });

});
