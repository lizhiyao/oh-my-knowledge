import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProfileOptions, profileTestRun } from '../../scripts/bench/test-profile.js';
import { testDirectory } from '../helpers/temp-directory.js';

function fixture() {
  const base = testDirectory('omk-profile-fixture-'), root = join(base, 'repository'), temporaryParent = join(base, 'temporary');
  mkdirSync(join(root, 'test/shards'), { recursive: true }); mkdirSync(temporaryParent);
  for (let i = 1; i <= 4; i++) writeFileSync(join(root, `test/shards/source-${i}.txt`), i === 1 ? 'test/fast.test.ts\n' : i === 2 ? 'test/slow.test.ts\n' : '');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('add', '.');
  git('-c', 'user.name=Profile fixture', '-c', 'user.email=profile@example.invalid', 'commit', '-qm', 'fixture');
  const options = { top: 1, workers: 1, output: join(base, 'profile.json'), rawDir: join(base, 'raw') };
  const results = [
    { name: join(root, 'test/fast.test.ts'), startTime: 100, endTime: 110, status: 'passed', assertionResults: [{ status: 'passed' }] },
    { name: join(root, 'test/slow.test.ts'), startTime: 100, endTime: 150, status: 'passed', assertionResults: [{ status: 'passed' }] },
  ];
  return { base, root, temporaryParent, options, results };
}

describe('test-profile', () => {
  it('保留 --top，显式选择 worker、JSON 输出与原始证据目录', () => {
    expect(parseProfileOptions([])).toEqual({ top: 15, workers: 1 });
    expect(parseProfileOptions(['--top', '8', '--workers', '2', '--output', 'new.json', '--raw-dir', '/tmp/new-profile'])).toEqual({ top: 8, workers: 2, output: 'new.json', rawDir: '/tmp/new-profile' });
    expect(parseProfileOptions(['--help'])).toBeUndefined();
    for (const args of [['--top', '0'], ['--workers', '1.5'], ['--workers', '9007199254740992'], ['--runs', '3'], ['--output'], ['--top', '1', '--top', '2']]) {
      expect(() => parseProfileOptions(args)).toThrow(/用法/);
    }
  });

  it('记录真实进程条件、相对文件路径、manifest 字节绑定与观测和，不包含绝对仓库路径', async () => {
    const f = fixture();
    const result = await profileTestRun(f.options, { ...f, async runTests({ reportFile, logFile, workers }) {
      expect(workers).toBe(1);
      expect(dirname(reportFile)).toContain(f.temporaryParent);
      writeFileSync(reportFile, JSON.stringify({ success: true, testResults: f.results }));
      writeFileSync(logFile, 'original runner log');
      return { code: 0, signal: null };
    } });
    const persisted = JSON.parse(readFileSync(f.options.output, 'utf8'));
    expect(persisted).toEqual(result.profile);
    expect(persisted).toMatchObject({ profileVersion: 'omk-test-profile/v1', source: { dirty: false }, sourceMetadataChanged: false,
      environment: { nodeVersion: process.version, workers: 1 }, status: 'passed', reportIssue: null });
    expect(persisted.files).toEqual([{ file: 'test/fast.test.ts', shard: 'test/shards/source-1.txt', status: 'passed', durationMs: 10 },
      { file: 'test/slow.test.ts', shard: 'test/shards/source-2.txt', status: 'passed', durationMs: 50 }]);
    expect(persisted.manifests[0].sha256).toBe(`sha256:${createHash('sha256').update('test/fast.test.ts\n').digest('hex')}`);
    expect(persisted.shards[0].observedFileDurationSumMs).toBe(10);
    expect(persisted.shards[2].observedFileDurationSumMs).toBeNull();
    expect(persisted.durationMeaning).toContain('not CI');
    expect(JSON.stringify(persisted)).not.toContain(f.root);
    expect(readFileSync(join(result.evidenceDirectory, 'runner.log'), 'utf8')).toBe('original runner log');
    expect(readdirSync(f.temporaryParent)).toEqual([]);
  });

  it('保留失败、缺失、未归属与未知时长，不把它们补成零或完整通过', async () => {
    const f = fixture();
    const { profile } = await profileTestRun(f.options, { ...f, async runTests({ reportFile }) {
      writeFileSync(reportFile, JSON.stringify({ success: false, testResults: [
        { ...f.results[0], status: 'failed', endTime: 90 },
        { name: join(f.root, 'test/unsharded.test.ts'), status: 'passed', startTime: 100, endTime: 120, assertionResults: [{ status: 'passed' }] },
      ] }));
      return { code: 1, signal: null };
    } });
    expect(profile.status).toBe('failed');
    expect(profile.files).toEqual([
      { file: 'test/fast.test.ts', shard: 'test/shards/source-1.txt', status: 'failed', durationMs: null },
      { file: 'test/slow.test.ts', shard: 'test/shards/source-2.txt', status: 'unknown', durationMs: null },
      { file: 'test/unsharded.test.ts', shard: null, status: 'passed', durationMs: 20 },
    ]);
    expect(profile.shards[0]).toMatchObject({ failedFiles: 1, unknownDurationFiles: 1, observedFileDurationSumMs: null });
    expect(readdirSync(f.temporaryParent)).toEqual([]);
    const g = fixture();
    const skipped = await profileTestRun(g.options, { ...g, async runTests({ reportFile }) {
      writeFileSync(reportFile, JSON.stringify({ success: true, testResults: [g.results[0],
        { ...g.results[1], startTime: 100, endTime: 100, assertionResults: [{ status: 'skipped' }] }] }));
      return { code: 0, signal: null };
    } });
    expect(skipped.profile.files[1]).toMatchObject({ status: 'skipped', durationMs: null });
    expect(skipped.profile.shards[1]).toMatchObject({ skippedFiles: 1, observedFileDurationSumMs: null });
  });

  it.each([
    { code: null, signal: 'SIGKILL', status: 'interrupted', raw: undefined, issue: 'missing_report' },
    { code: 1, signal: null, status: 'failed', raw: '{invalid', issue: 'invalid_report' },
    { code: 0, signal: null, status: 'incomplete', raw: undefined, issue: 'missing_report' },
  ])('报告不完整时保留 $status 及原始诊断，并清理运行临时根', async ({ code, signal, status, raw, issue }) => {
    const f = fixture();
    const { profile } = await profileTestRun(f.options, { ...f, async runTests({ reportFile, logFile }) {
      if (raw !== undefined) writeFileSync(reportFile, raw);
      writeFileSync(logFile, 'last progress before exit');
      return { code, signal };
    } });
    expect(profile).toMatchObject({ status, reportIssue: issue, exit: { code, signal } });
    expect(profile.files).toHaveLength(2);
    expect(profile.files.every(file => file.status === 'unknown' && file.durationMs === null)).toBe(true);
    expect(readFileSync(join(f.options.rawDir, 'runner.log'), 'utf8')).toBe('last progress before exit');
    expect(JSON.parse(readFileSync(join(f.options.rawDir, 'process.json'), 'utf8')).exit).toEqual({ code, signal });
    expect(readdirSync(f.temporaryParent)).toEqual([]);
  });

  it('启动异常和源清单变化不能伪装成成功，原始失败原因只留仓库外', async () => {
    const f = fixture();
    const { profile } = await profileTestRun(f.options, { ...f, async runTests() { throw new Error('private spawn failure'); } });
    expect(profile).toMatchObject({ status: 'unknown', exit: { spawnError: true } });
    expect(JSON.stringify(profile)).not.toContain('private spawn failure');
    expect(readFileSync(join(f.options.rawDir, 'process.json'), 'utf8')).toContain('private spawn failure');
    expect(readdirSync(f.temporaryParent)).toEqual([]);
    const g = fixture();
    const changed = await profileTestRun(g.options, { ...g, async runTests({ reportFile }) {
      writeFileSync(reportFile, JSON.stringify({ success: true, testResults: g.results }));
      writeFileSync(join(g.root, 'test/shards/source-4.txt'), '# changed during execution\n');
      return { code: 0, signal: null };
    } });
    expect(changed.profile).toMatchObject({ sourceMetadataChanged: true, status: 'incomplete', sourceAfter: { dirty: true } });
  });

  it('不覆盖既有输出、悬空软链或运行期间新出现的输出，发布失败也清理临时根', async () => {
    const f = fixture();
    writeFileSync(f.options.output, 'original');
    await expect(profileTestRun(f.options, f)).rejects.toThrow(/不覆盖/);
    expect(readFileSync(f.options.output, 'utf8')).toBe('original');
    const dangling = join(f.base, 'dangling'); symlinkSync(join(f.base, 'missing'), dangling);
    await expect(profileTestRun({ ...f.options, output: dangling }, f)).rejects.toThrow(/不覆盖/);
    const g = fixture();
    await expect(profileTestRun(g.options, { ...g, async runTests({ reportFile }) {
      writeFileSync(reportFile, JSON.stringify({ success: true, testResults: g.results }));
      writeFileSync(g.options.output, 'concurrent output');
      return { code: 0, signal: null };
    } })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(g.options.output, 'utf8')).toBe('concurrent output');
    expect(existsSync(join(g.options.rawDir, 'vitest.json'))).toBe(true);
    expect(readdirSync(g.temporaryParent)).toEqual([]);
  });

  it('拒绝仓库内原始证据目录与重复归属清单', async () => {
    const f = fixture();
    await expect(profileTestRun({ ...f.options, rawDir: join(f.root, 'raw') }, f)).rejects.toThrow(/仓库外/);
    await expect(profileTestRun(f.options, { ...f, temporaryParent: f.root })).rejects.toThrow(/仓库外/);
    writeFileSync(join(f.root, 'test/shards/source-3.txt'), 'test/fast.test.ts\n');
    await expect(profileTestRun(f.options, f)).rejects.toThrow(/重复/);
    expect(existsSync(f.options.rawDir)).toBe(false);
  });

  it.each([false, true])('真实 wrapper 接线传递参数并保留子进程信号（中断=%s）', async (interrupted) => {
    const f = fixture();
    mkdirSync(join(f.root, 'scripts/ci'), { recursive: true });
    writeFileSync(join(f.root, 'scripts/ci/test.mjs'), `import {writeFileSync} from 'node:fs';
process.stdout.write(JSON.stringify(process.argv.slice(2))+'\\n');
if (${interrupted}) process.kill(process.pid,'SIGTERM');
const output=process.argv.find(arg=>arg.startsWith('--outputFile.json=')).slice('--outputFile.json='.length);
writeFileSync(output,JSON.stringify({success:true,testResults:${JSON.stringify(f.results)}}));\n`);
    const { profile } = await profileTestRun({ ...f.options, workers: 2 }, f);
    expect(profile.status).toBe(interrupted ? 'interrupted' : 'passed');
    if (interrupted) expect(profile.exit.signal).toBe('SIGTERM');
    const actual = JSON.parse(readFileSync(join(f.options.rawDir, 'runner.log'), 'utf8').trim());
    expect(actual.slice(0, 3)).toEqual(['--maxWorkers=2', '--reporter=default', '--reporter=json']);
    expect(actual[3]).toContain('--outputFile.json=');
    expect(profile.command[1]).toBe('scripts/ci/test.mjs');
    expect(readdirSync(f.temporaryParent)).toEqual([]);
  });
});
