/**
 * observe-inbox 的 --global 写 / 读对称验收(子进程实跑真 CLI),覆盖 ingest / inbox / show:
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
import { isReportFileName } from '../../src/eval-core/artifact-file-names.js';

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
  return existsSync(dir) ? readdirSync(dir).filter(isReportFileName) : [];
}

const globalInbox = (home: string): string => join(home, 'observe-inbox');
const projectInbox = (project: string): string => join(project, '.omk', 'observe-inbox');

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

      const s2 = box();
      try {
        await cli(['observe', 'ingest', makeTrace(join(s2.base, 'tp'), 'pskill')], s2.project, s2.env);
        assert.equal(inboxJsons(projectInbox(s2.project)).length, 1, '默认写项目');
        assert.deepEqual(inboxJsons(globalInbox(s2.home)), [], '默认不落全局');
      } finally { s2.cleanup(); }
    } finally { s.cleanup(); }
  });

  it('inbox --global 钉死全局、默认读项目:用可区分内容证明读路由不串', async () => {
    const s = box();
    try {
      await cli(['observe', 'ingest', makeTrace(join(s.base, 'tg'), 'gskill'), '--global'], s.project, s.env);
      await cli(['observe', 'ingest', makeTrace(join(s.base, 'tp'), 'pskill')], s.project, s.env); // 默认写项目

      const g = skillNames(await cli(['observe', 'inbox', '--global', '--json'], s.project, s.env));
      assert.ok(g.length > 0, '--global 读到非空');
      assert.ok(g.includes('gskill'), '--global 含全局那条');
      assert.ok(!g.includes('pskill'), '--global 不串项目数据');

      const d = skillNames(await cli(['observe', 'inbox', '--json'], s.project, s.env));
      assert.ok(d.length > 0, '默认读到非空');
      assert.ok(d.includes('pskill'), '默认含项目那条');
      assert.ok(!d.includes('gskill'), '项目非空时默认不串全局');
    } finally { s.cleanup(); }
  });

  it('inbox 默认在项目目录缺失时兜底读全局', async () => {
    const s = box();
    try {
      await cli(['observe', 'ingest', makeTrace(join(s.base, 'tg'), 'gskill'), '--global'], s.project, s.env);
      // 项目从未写过 → .omk/observe-inbox 不存在 → loadObservationInboxReports 兜底全局。
      assert.ok(!existsSync(projectInbox(s.project)), '前提:项目 inbox 目录不存在');
      const d = skillNames(await cli(['observe', 'inbox', '--json'], s.project, s.env));
      assert.ok(d.includes('gskill'), '默认兜底读到全局');
    } finally { s.cleanup(); }
  });

  it('显式 --output-dir / --input-dir 胜过 --global', async () => {
    const s = box();
    try {
      const explicit = join(s.base, 'explicit');
      await cli(['observe', 'ingest', makeTrace(join(s.base, 'tx'), 'xskill'), '--output-dir', explicit, '--global'], s.project, s.env);
      assert.equal(inboxJsons(explicit).length, 1, '--output-dir 胜过 --global,落显式目录');
      assert.deepEqual(inboxJsons(globalInbox(s.home)), [], '--global 被 --output-dir 压住,全局不落');

      const r = skillNames(await cli(['observe', 'inbox', '--input-dir', explicit, '--global', '--json'], s.project, s.env));
      assert.ok(r.includes('xskill'), '--input-dir 胜过 --global,读显式目录');
    } finally { s.cleanup(); }
  });

  it('show --global 读到全局那条;项目非空时默认 show 读不到(闭环已补)', async () => {
    const s = box();
    try {
      await cli(['observe', 'ingest', makeTrace(join(s.base, 'tg'), 'gskill'), '--global'], s.project, s.env);
      await cli(['observe', 'ingest', makeTrace(join(s.base, 'tp'), 'pskill')], s.project, s.env); // 项目非空 → 默认不兜底
      const items = JSON.parse(await cli(['observe', 'inbox', '--global', '--json'], s.project, s.env)).items as Array<{ id: string; skillName: string }>;
      const gid = items.find((i) => i.skillName === 'gskill')?.id;
      assert.ok(gid, '从 inbox --global 拿到全局那条的 id');

      const shown = await cli(['observe', 'show', gid as string, '--global'], s.project, s.env);
      assert.ok(shown.length > 0, 'show --global 读到全局那条详情');

      // 不带 --global:项目目录非空 → 不兜底全局 → 找不到这条全局 id(证明缺口已被 --global 补上)。
      try {
        await cli(['observe', 'show', gid as string], s.project, s.env);
        assert.fail('预期默认 show 找不到全局 id 而非零退出');
      } catch (err) {
        assert.equal((err as ExecError).code, 1, '默认 show 找不到 → exit 1');
      }
    } finally { s.cleanup(); }
  });

});
