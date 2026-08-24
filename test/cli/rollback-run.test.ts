/**
 * `omk rollback` command 编排测：锁住「撤销当前 promoted 接受」的闭环契约 ——
 *   - 已 promoted → rollback 退 0、追加 rollback 决定、`omk list` 回 measurable;
 *   - 未 promoted(仅 install)→ 退 1 not_promoted,不写决定;
 *   - 已 rollback 再 rollback → 退 0 幂等、不堆决定;
 *   - 源漂移后 rollback 仍可撤销旧 baseline 接受;
 *   - --json 出版本化信封。
 * promoted 态由真实 `omk promote` 建立(证据 judgePromptHash 取自真实 getJudgePromptHash),故 rollback
 * 打到的是真链路而非 mock。HOME 指临时空目录,避免回退本机全局受管目录。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashArtifactSource, managedRecordId } from '../../src/managed/index.js';
import { getJudgePromptHash } from '../../src/grading/judge.js';
import PromoteCommand from '../../src/cli/commands/promote.js';
import RollbackCommand from '../../src/cli/commands/rollback.js';
import ListCommand from '../../src/cli/commands/list.js';
import { runCommand } from '../helpers/run-command.js';

interface RunResult { code: number; stdout: string; stderr: string; }

describe('omk rollback command', () => {
  let proj: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  let managed: string;
  let srcPath: string;
  let recId: string;
  let curHash: string;

  /** 写一条受管记录,带一条「当前内容」PROGRESS 证据(够 promote 门禁)。 */
  function writeRecord(): void {
    const rec = {
      recordKind: 'managed-artifact', schemaVersion: 2, id: recId, name: 'review', kind: 'skill',
      source: { sourceKind: 'file', locator: srcPath, isDirectorySkill: false },
      contentHash: curHash, installedAt: '2026-06-06T00:00:00.000Z',
      distribution: [],
      evidence: [{
        reportId: 'rep1', contentHash: curHash, recordedAt: '2026-06-07T00:00:00.000Z',
        verdict: 'PROGRESS', comparability: { cliVersion: '0.36.0', judgePromptHash: getJudgePromptHash(true) },
      }],
      decisions: [],
    };
    writeFileSync(join(managed, `${recId}.json`), JSON.stringify(rec));
  }

  function readDecisions(): Array<{ decisionKind: string; contentHash?: string; reason?: string }> {
    return JSON.parse(readFileSync(join(managed, `${recId}.json`), 'utf-8')).decisions;
  }

  const run = async (args: string[]): Promise<RunResult> => {
    const [command, ...commandArgs] = args;
    const CommandType = command === 'promote'
      ? PromoteCommand
      : command === 'rollback'
        ? RollbackCommand
        : ListCommand;
    try {
      const { stdout, stderr } = await runCommand(CommandType, [...commandArgs, '--lang', 'en'], { cwd: proj, env });
      return { code: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  };

  const stateOf = async (): Promise<string> => JSON.parse((await run(['list', '--json'])).stdout).rows[0].state;

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'omk-rollback-proj-'));
    home = mkdtempSync(join(tmpdir(), 'omk-rollback-home-'));
    env = { ...process.env, HOME: home, USERPROFILE: home };
    managed = join(proj, '.omk', 'managed');
    mkdirSync(managed, { recursive: true });
    srcPath = join(proj, 'review.md');
    writeFileSync(srcPath, '# review skill\n\ndo the thing.\n');
    curHash = hashArtifactSource(srcPath, false);
    recId = managedRecordId('skill', 'review');
  });
  afterEach(() => { rmSync(proj, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

  it('已 promoted → rollback 退 0、追加 rollback 决定、list 回 measurable', async () => {
    writeRecord();
    await run(['promote', 'review']);
    assert.equal(await stateOf(), 'promoted');
    const r = await run(['rollback', 'review', '--reason', '线上发现回归']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('Rolled back review'), `成功行在 stdout:${r.stdout}`);
    const decs = readDecisions();
    assert.equal(decs.length, 2, 'promote + rollback');
    assert.equal(decs[1].decisionKind, 'rollback');
    assert.equal(decs[1].contentHash, curHash, '回退锚定当前内容 hash');
    assert.equal(decs[1].reason, '线上发现回归');
    assert.equal(await stateOf(), 'measurable', 'rollback 后回到 measurable');
  });

  it('未 promoted(仅 install)→ 退 1 not_promoted,不写决定', async () => {
    writeRecord();
    const r = await run(['rollback', 'review']);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('not promoted'), `not_promoted 提示:${r.stderr}`);
    assert.equal(readDecisions().length, 0, '无可回退不写决定');
  });

  it('幂等:已 rollback 再 rollback → 退 0、不堆第二条 rollback', async () => {
    writeRecord();
    await run(['promote', 'review']);
    await run(['rollback', 'review']);
    const r = await run(['rollback', 'review']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stderr.includes('already not promoted'), `幂等提示:${r.stderr}`);
    assert.equal(readDecisions().length, 2, 'promote + 一条 rollback,不重复');
  });

  it('已 promoted 后源漂移 → rollback 仍成功(撤销旧 baseline 接受),但 list 仍 stale(rollback 不探源)', async () => {
    writeRecord();
    await run(['promote', 'review']);
    // promote 后编辑源 → 源 hash 漂移,list 现为 stale。
    writeFileSync(srcPath, '# review skill\n\ndo the OTHER thing now.\n');
    assert.equal(await stateOf(), 'stale', '改源后应为 stale');
    const r = await run(['rollback', 'review']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('Rolled back review'), '撤销旧 baseline 接受仍成功');
    const decs = readDecisions();
    assert.equal(decs.length, 2, 'promote + rollback');
    assert.equal(decs[1].decisionKind, 'rollback');
    assert.equal(await stateOf(), 'stale', 'rollback 不探源、不消解 drift → list 仍 stale,不是 measurable');
  });

  it('--json:成功出 rolledBack 信封', async () => {
    writeRecord();
    await run(['promote', 'review']);
    const r = await run(['rollback', 'review', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.rolledBack.name, 'review');
    assert.equal(parsed.rolledBack.contentHash, curHash);
  });

  it('--json:未 promoted 出 notPromoted 信封 退 1', async () => {
    writeRecord();
    const r = await run(['rollback', 'review', '--json']);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stdout).notPromoted.name, 'review');
  });

  it('记录不存在 → 退 1 not_managed', async () => {
    const r = await run(['rollback', 'ghost']);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('No managed record'), r.stderr);
  });

  it('--kind 非 skill → 退 1 kind_unsupported', async () => {
    const r = await run(['rollback', 'review', '--kind', 'prompt']);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('only kind=skill'), `kind_unsupported 拦截:${r.stderr}`);
  });

});
