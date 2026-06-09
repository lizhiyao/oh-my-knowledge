/**
 * `omk promote` 端到端编排测(execFile 打到 dist):锁住门禁 + 写决定 + 生命周期跃迁的闭环契约 ——
 *   - PROGRESS + 可比 + 不漂 → 退 0、记录追加 promote 决定、`omk list` 显 promoted ✓;
 *   - verdict 不达标 / 源漂移 / 记录不存在 → 退 1,拦截原因走 stderr;
 *   - --force 越门 → 退 0 且决定带 override;无当前证据 / 可达源 hash 已变 → force 也退 1;
 *   - --json 出版本化信封。
 * 证据 fixture 的 judgePromptHash 取自真实 getJudgePromptHash,contentHash 取自真实 hashArtifactSource,
 * 故门禁的可比性 / drift 判定都打到真实口径而非 mock。HOME 指临时空目录,避免回退本机全局受管目录。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { hashArtifactSource, managedRecordId } from '../../src/managed/index.js';
import { getJudgePromptHash } from '../../src/grading/judge.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

interface RunResult { code: number; stdout: string; stderr: string; }

describe('omk promote 端到端', () => {
  let proj: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  let managed: string;
  let srcPath: string;
  let recId: string;
  let curHash: string;

  /** 写一条受管记录,带一条「当前内容」证据(verdict / judgeHash 可定制)。 */
  function writeRecord(opts: { verdict?: string; judgeHash?: string; contentHash?: string } = {}): void {
    const judge = opts.judgeHash ?? getJudgePromptHash(true);
    const rec = {
      recordKind: 'managed-artifact', schemaVersion: 2, id: recId, name: 'review', kind: 'skill',
      source: { sourceKind: 'file', locator: srcPath, isDirectorySkill: false },
      contentHash: opts.contentHash ?? curHash, installedAt: '2026-06-06T00:00:00.000Z',
      distribution: [],
      evidence: [{
        reportId: 'rep1', contentHash: opts.contentHash ?? curHash, recordedAt: '2026-06-07T00:00:00.000Z',
        verdict: opts.verdict ?? 'PROGRESS', comparability: { cliVersion: '0.36.0', judgePromptHash: judge },
      }],
      decisions: [],
    };
    writeFileSync(join(managed, `${recId}.json`), JSON.stringify(rec));
  }

  function readRecord(): { decisions: Array<{ decisionKind: string; contentHash?: string; reason?: string; override?: { verdict: string; overriddenBlocks?: string[] } }> } {
    return JSON.parse(readFileSync(join(managed, `${recId}.json`), 'utf-8'));
  }

  const run = async (args: string[]): Promise<RunResult> => {
    try {
      const { stdout, stderr } = await execFileAsync('node', [CLI, ...args, '--lang', 'en'], { cwd: proj, env });
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
    managed = join(proj, '.omk', 'managed');
    mkdirSync(managed, { recursive: true });
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

  it('幂等:已 promote 的当前内容再 promote → 退 0、不堆第二条决定', async () => {
    writeRecord({ verdict: 'PROGRESS' });
    await run(['promote', 'review']);
    const r = await run(['promote', 'review']);
    assert.equal(r.code, 0);
    assert.ok(r.stderr.includes('already promoted'), `幂等提示:${r.stderr}`);
    assert.equal(readRecord().decisions.length, 1, '不重复追加');
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

  it('--accept-cautious:放行 CAUTIOUS', async () => {
    writeRecord({ verdict: 'CAUTIOUS' });
    assert.equal((await run(['promote', 'review'])).code, 1, '默认拦 CAUTIOUS');
    const r = await run(['promote', 'review', '--accept-cautious']);
    assert.equal(r.code, 0, r.stderr);
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

  it('无当前证据 → 退 1,force 也越不过', async () => {
    // 证据是旧内容的(contentHash 与记录基线不同)→ 无当前证据。
    const rec = {
      recordKind: 'managed-artifact', schemaVersion: 2, id: recId, name: 'review', kind: 'skill',
      source: { sourceKind: 'file', locator: srcPath, isDirectorySkill: false },
      contentHash: curHash, installedAt: '2026-06-06T00:00:00.000Z', distribution: [],
      evidence: [{ reportId: 'rep1', contentHash: 'OLDCONTENT00', recordedAt: 't', verdict: 'PROGRESS' }],
      decisions: [],
    };
    writeFileSync(join(managed, `${recId}.json`), JSON.stringify(rec));
    assert.equal((await run(['promote', 'review'])).code, 1, '无当前证据拦');
    assert.equal((await run(['promote', 'review', '--force', '--reason', 'x'])).code, 1, 'force 也越不过空证据');
  });

  it('记录不存在 → 退 1 not_managed', async () => {
    const r = await run(['promote', 'ghost']);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('No managed record'), r.stderr);
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

  it('评委已变(judgePromptHash 失配)→ 退 1 incomparable;--force 越门记 override', async () => {
    writeRecord({ verdict: 'PROGRESS', judgeHash: 'STALE_JUDGE_NOT_CURRENT' });
    const blocked = await run(['promote', 'review']);
    assert.equal(blocked.code, 1);
    assert.ok(blocked.stderr.includes('not the current judge'), `incomparable 拦截:${blocked.stderr}`);
    assert.equal(readRecord().decisions.length, 0);
    const forced = await run(['promote', 'review', '--force', '--reason', 'ok']);
    assert.equal(forced.code, 0, forced.stderr);
    assert.deepEqual(readRecord().decisions[0].override?.overriddenBlocks, ['incomparable'], 'override 标明越过 incomparable');
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
  });

  it('不可信受管 JSON 的 verdict 含 ANSI/控制符 → 文本输出洗成 U+FFFD,不喷转义', async () => {
    // verdict 写成带 ESC/OSC/CR 的串(validator 只卡「是字符串」),走 verdict_blocked 拦截分支打到 stderr。
    writeRecord({ verdict: '\x1b[2J\x1b]0;PWNED\x07\rNOISE' });
    const r = await run(['promote', 'review']);
    assert.equal(r.code, 1);
    assert.ok(!r.stderr.includes('\x1b'), 'ESC 不得原样喷到终端');
    assert.ok(!r.stderr.includes('\x07'), 'BEL 不得原样喷出');
    assert.ok(r.stderr.includes('�'), '控制符应映射为 U+FFFD');
    // --json 路径保留原值(脚本消费要原始),仅文本路径洗。
    const j = await run(['promote', 'review', '--json']);
    assert.ok(JSON.parse(j.stdout).blocked.reasons[0].detail.verdict.includes('\x1b'), '--json 保留原值');
  });
});
