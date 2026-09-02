/**
 * `omk promote` command 编排测：锁住门禁 + 写决定 + 生命周期跃迁的闭环契约 ——
 *   - PROGRESS + 可比 + 不漂 → 退 0、记录追加 promote 决定、`omk list` 显 promoted ✓;
 *   - verdict 不达标 / 源漂移 / 记录不存在 → 退 1,拦截原因走 stderr;
 *   - --force 越门 → 退 0 且决定带 override;可达源 hash 已变时仍拒;
 *   - --json 出版本化信封。
 * 证据 fixture 的 judgePromptHash 取自真实 getJudgePromptHash,contentHash 取自真实 hashArtifactSource,
 * 故 drift 判定打到真实口径而非 mock。HOME 指临时空目录,避免回退本机全局受管目录。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashArtifactSource, managedRecordId } from '../../src/managed/index.js';
import PromoteCommand from '../../src/cli/commands/promote.js';
import ListCommand from '../../src/cli/commands/list.js';
import { runCommand } from '../helpers/run-command.js';
import { coreManagedEvidence } from '../helpers/core-managed-evidence.js';

interface RunResult { code: number; stdout: string; stderr: string; }

describe('omk promote command', () => {
  let proj: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  let managed: string;
  let legacyManaged: string;
  let srcPath: string;
  let recId: string;
  let curHash: string;

  /** 写一条受管记录,带一条「当前内容」证据。 */
  function writeRecord(opts: { verdict?: string; contentHash?: string; evidenceReadiness?: 'decision-ready' | 'measurement-only'; withoutEvidence?: boolean } = {}): void {
    const rec = {
      recordKind: 'managed-artifact', schemaVersion: 3, id: recId, name: 'review', kind: 'skill',
      source: { sourceKind: 'file', locator: srcPath, isDirectorySkill: false },
      contentHash: opts.contentHash ?? curHash, installedAt: '2026-06-06T00:00:00.000Z',
      distribution: [],
      evidence: opts.withoutEvidence ? [] : [coreManagedEvidence(opts.contentHash ?? curHash, {
        reportId: 'rep1',
        verdict: opts.verdict ?? 'PROGRESS',
        evidenceReadiness: opts.evidenceReadiness ?? 'decision-ready',
      })],
      decisions: [],
    };
    writeFileSync(join(legacyManaged, `${recId}.json`), JSON.stringify(rec));
  }

  function readRecord(): { decisions: Array<{ decisionKind: string; contentHash?: string; reason?: string; override?: { verdict: string; overriddenBlocks?: string[] } }> } {
    const path = existsSync(join(managed, `${recId}.json`))
      ? join(managed, `${recId}.json`)
      : join(legacyManaged, `${recId}.json`);
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  const run = async (args: string[]): Promise<RunResult> => {
    const [command, ...commandArgs] = args;
    const CommandType = command === 'promote' ? PromoteCommand : ListCommand;
    try {
      const { stdout, stderr } = await runCommand(CommandType, [...commandArgs, '--lang', 'en'], { cwd: proj, env });
      return { code: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  };

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'omk-promote-proj-'));
    home = mkdtempSync(join(tmpdir(), 'omk-promote-home-'));
    env = { ...process.env, HOME: home, USERPROFILE: home };
    managed = join(proj, '.omk', 'governance', 'managed');
    legacyManaged = join(proj, '.omk', 'managed');
    mkdirSync(legacyManaged, { recursive: true });
    srcPath = join(proj, 'review.md');
    writeFileSync(srcPath, '# review skill\n\ndo the thing.\n');
    curHash = hashArtifactSource(srcPath, false);
    recId = managedRecordId('skill', 'review');
  });
  afterEach(() => { rmSync(proj, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

  it('PROGRESS 达标 → 退 0、追加 promote 决定、list 显 promoted', async () => {
    writeRecord({ verdict: 'PROGRESS' });
    const r = await run(['promote', 'review']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('Promoted review'), `成功行在 stdout:${r.stdout}`);
    const decs = readRecord().decisions;
    assert.equal(decs.length, 1);
    assert.equal(decs[0].decisionKind, 'promote');
    assert.equal(decs[0].contentHash, curHash, '决定锚定当前内容 hash');
    assert.ok(decs[0].override === undefined, '正常通过不记 override');
    const list = await run(['list', '--json']);
    assert.equal(JSON.parse(list.stdout).rows[0].state, 'promoted', 'list 显 promoted');
  });

  it('幂等:已 promote 后源不可达 → 仍 no-op,不误走 drift gate', async () => {
    writeRecord({ verdict: 'PROGRESS' });
    await run(['promote', 'review']);
    rmSync(srcPath, { force: true });

    const r = await run(['promote', 'review']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stderr.includes('already promoted'), `不可达已 promoted 应仍幂等:${r.stderr}`);
    assert.equal(readRecord().decisions.length, 1, '不可达 no-op 不堆第二条决定');
  });

  it('verdict=NOISE → 退 1,拦截原因走 stderr,记录不变', async () => {
    writeRecord({ verdict: 'NOISE' });
    const r = await run(['promote', 'review']);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('blocked by the gate'), `拦截头:${r.stderr}`);
    assert.ok(r.stderr.includes('verdict=NOISE'), '点名被拦 verdict');
    assert.equal(readRecord().decisions.length, 0, '被拦不写决定');
  });

  it('--accept-cautious 把 CAUTIOUS 接到门禁并放行', async () => {
    writeRecord({ verdict: 'CAUTIOUS' });
    assert.equal((await run(['promote', 'review'])).code, 1, '默认仍拦 CAUTIOUS');
    const accepted = await run(['promote', 'review', '--accept-cautious']);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(readRecord().decisions[0].decisionKind, 'promote');
  });

  it('--force:越门 NOISE → 退 0,决定记 override.verdict', async () => {
    writeRecord({ verdict: 'NOISE' });
    const r = await run(['promote', 'review', '--force', '--reason', '已人工复核']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('force-promoted'), `越门成功行在 stdout:${r.stdout}`);
    const dec = readRecord().decisions[0];
    assert.equal(dec.override?.verdict, 'NOISE', '记下被越过的 verdict');
    assert.deepEqual(dec.override?.overriddenBlocks, ['verdict_blocked'], '记下被越过的判据');
    assert.equal(dec.reason, '已人工复核', 'override 必须留 reason');
  });

  it('--force 越门但缺 reason → 退 1,不写决定', async () => {
    writeRecord({ verdict: 'NOISE' });
    const r = await run(['promote', 'review', '--force']);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('--force requires'), `缺 reason 提示:${r.stderr}`);
    assert.equal(readRecord().decisions.length, 0, '缺 reason 不得写 override 决定');
  });

  it('源可达但 contentHash 不匹配 → 退 1 drifted;--force 也越不过', async () => {
    writeRecord({ verdict: 'PROGRESS', contentHash: 'DRIFTED00000' }); // 记录基线与真源不一致
    const blocked = await run(['promote', 'review']);
    assert.equal(blocked.code, 1);
    assert.ok(blocked.stderr.includes('drifted or unreachable'), `drift 拦截:${blocked.stderr}`);
    assert.ok(!blocked.stderr.includes('To override anyway'), 'hash 已变不是可越门场景,不提示 --force');
    const forced = await run(['promote', 'review', '--force', '--reason', 'ok']);
    assert.equal(forced.code, 1, forced.stderr);
    assert.equal(readRecord().decisions.length, 0, 'hash 已变 force 也不得写旧 hash promote 决定');
  });

  it('源不可达但当前证据存在 → --force + reason 可越门,并在 list 保持 promoted', async () => {
    writeRecord({ verdict: 'PROGRESS' });
    rmSync(srcPath, { force: true });
    const blocked = await run(['promote', 'review']);
    assert.equal(blocked.code, 1);
    assert.ok(blocked.stderr.includes('To override anyway'), `不可达但有证据应允许人工越门:${blocked.stderr}`);
    const forced = await run(['promote', 'review', '--force', '--reason', '源在另一台机器已核对']);
    assert.equal(forced.code, 0, forced.stderr);
    const list = await run(['list', '--json']);
    const row = JSON.parse(list.stdout).rows[0];
    assert.equal(row.state, 'promoted');
    assert.equal(row.reachable, false, 'promoted 但仍标明当前环境源未核');
  });

  it('无当前证据 → --force 也不能越门', async () => {
    writeRecord({ withoutEvidence: true });
    const blocked = await run(['promote', 'review', '--force', '--reason', '已人工复核']);
    assert.equal(blocked.code, 1);
    assert.ok(blocked.stderr.includes('no evaluation evidence for the current content'), blocked.stderr);
    assert.equal(readRecord().decisions.length, 0);
  });

  it('Core evidence 仅 measurement-only → 默认阻断；--force 留下显式审计', async () => {
    writeRecord({ evidenceReadiness: 'measurement-only' });
    const blocked = await run(['promote', 'review']);
    assert.equal(blocked.code, 1);
    assert.ok(blocked.stderr.includes('CORE_EVIDENCE_NOT_DECISION_READY'), blocked.stderr);
    const forced = await run(['promote', 'review', '--force', '--reason', '已人工复核测量证据']);
    assert.equal(forced.code, 0, forced.stderr);
    assert.deepEqual(readRecord().decisions[0].override?.overriddenBlocks, ['verdict_blocked']);
  });

  it('记录不存在 → 退 1 not_managed', async () => {
    const r = await run(['promote', 'ghost']);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('No managed record'), r.stderr);
  });

  it('--kind 非 skill → 退 1 kind_unsupported,点名收到的 kind', async () => {
    const r = await run(['promote', 'review', '--kind', 'prompt']);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('only kind=skill'), `kind_unsupported 拦截:${r.stderr}`);
    assert.ok(r.stderr.includes('prompt'), '点名收到的 kind');
  });

  it('CLI-arg name 含 ANSI/控制符 → 文本输出洗成 U+FFFD,不喷转义', async () => {
    // name 是用户 CLI 入参,not_managed 回显路径必须洗白,防 ANSI/OSC 终端注入。
    const r = await run(['promote', 'gh\x1b]0;PWNED\x07\x1b[2Jost']);
    assert.equal(r.code, 1);
    assert.ok(!r.stderr.includes('\x1b'), 'ESC 不得原样喷到终端');
    assert.ok(!r.stderr.includes('\x07'), 'BEL 不得原样喷出');
    assert.ok(r.stderr.includes('�'), '控制符应映射为 U+FFFD');
  });

  it('--json:成功出版本化信封', async () => {
    writeRecord({ verdict: 'PROGRESS' });
    const r = await run(['promote', 'review', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.promoted.name, 'review');
    assert.equal(parsed.promoted.verdict, 'PROGRESS');
    assert.equal(parsed.promoted.override, false);
  });

  it('--json:拦截出版本化信封 { schemaVersion:1, blocked:{ reasons:[{blockKind,detail}] } }', async () => {
    writeRecord({ verdict: 'NOISE' });
    const r = await run(['promote', 'review', '--json']);
    assert.equal(r.code, 1);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.blocked.name, 'review');
    assert.equal(parsed.blocked.reasons[0].blockKind, 'verdict_blocked');
    assert.equal(parsed.blocked.reasons[0].detail.verdict, 'NOISE');
  });

  it('--json:幂等出 alreadyPromoted 信封', async () => {
    writeRecord({ verdict: 'PROGRESS' });
    await run(['promote', 'review']);
    const r = await run(['promote', 'review', '--json']);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.alreadyPromoted.name, 'review');
    assert.equal(parsed.alreadyPromoted.contentHash, curHash);
    assert.equal(readRecord().decisions.length, 1, '幂等路径不重复追加决定');
  });
});
