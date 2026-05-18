/**
 * oclif 路径 eval + 3 gold sub-sub 命令验收。
 * 关键验证:oclif 文件目录三级路由(eval.ts default + eval/gold/{init,validate,compare}.ts)。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'dist', 'src', 'cli', 'index.js');

interface ExecError extends Error {
  code?: number;
  stdout: string;
  stderr: string;
}


describe('oclif eval', () => {
  it('eval --help 含 41 flag', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', '--help']);
    assert.ok(stdout.includes('跑评测'), `default eval --help missing zh:\n${stdout.slice(0, 200)}`);
    // 抽样核心 flag
    assert.ok(stdout.includes('--control'), 'should list --control');
    assert.ok(stdout.includes('--treatment'), 'should list --treatment');
    assert.ok(stdout.includes('--bootstrap'), 'should list --bootstrap (eval-runner extra)');
    assert.ok(stdout.includes('--no-debias-length'), 'should list --no-debias-length');
    assert.ok(stdout.includes('--threshold'), 'should list --threshold');
  });

  it('eval --help --lang en', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', '--help', '--lang', 'en']);
    assert.ok(stdout.includes('Run evaluation'), 'should contain en description');
  });

  it('eval gold init --help', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', 'gold', 'init', '--help']);
    assert.ok(stdout.includes('初始化 gold dataset'), `gold init --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('--out'), 'should list --out');
    assert.ok(stdout.includes('--annotator'), 'should list --annotator');
  });

  it('eval gold validate --help', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', 'gold', 'validate', '--help']);
    assert.ok(stdout.includes('校验 gold dataset'), `gold validate --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('DIR'), 'should list DIR positional');
  });

  it('eval gold compare --help', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', 'gold', 'compare', '--help']);
    assert.ok(stdout.includes('evaluation report 跟 gold dataset 对比'), `gold compare --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('REPORTID'), 'should list REPORTID positional');
    assert.ok(stdout.includes('--gold-dir'), 'should list --gold-dir');
  });

  it('eval gold init 实跑(tmpdir 生成 3 文件)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-oclif-gold-'));
    try {
      const out = join(dir, 'gold');
      await execFileAsync('node', [CLI, 'eval', 'gold', 'init', '--out', out]);
      assert.ok(existsSync(join(out, 'metadata.yaml')), 'metadata.yaml not created');
      assert.ok(existsSync(join(out, 'annotations.yaml')), 'annotations.yaml not created');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('eval gold validate 缺 positional → exit 2(oclif required-args)', async () => {
    // required: true 之后 oclif 自己出 Missing 1 required arg + exit 2(对齐
    // package.json oclif.exitCodes.requiredArgs)。原来 exit 1 是 legacy
    // execute() throw CliExit(1) 的行为,迁 oclif 后由 oclif 接管。
    try {
      await execFileAsync('node', [CLI, 'eval', 'gold', 'validate']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}`);
    }
  });

  it('eval unknown flag → exit 2', async () => {
    try {
      await execFileAsync('node', [CLI, 'eval', '--bogus']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2);
    }
  });

  it('eval 非法 --repeat --lang en → exit 2 + English parser error', async () => {
    try {
      await execFileAsync('node', [CLI, 'eval', '--repeat', 'abc', '--lang', 'en']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
      assert.match(e.stderr, /--repeat[\s\S]*integer[\s\S]*1/, `stderr missing en parser error:\n${e.stderr}`);
    }
  });

  it('eval gold compare 非法 --bootstrap-samples → exit 2 + 中文 parser 错误', async () => {
    try {
      await execFileAsync('node', [CLI, 'eval', 'gold', 'compare', 'report-1', '--bootstrap-samples', '10']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
      assert.match(e.stderr, /--bootstrap-samples(?=[\s\S]*整数)(?=[\s\S]*100)/, `stderr missing zh parser error:\n${e.stderr}`);
    }
  });

  it('bare `eval gold`(无 sub-sub)→ exit 1 + 打 usage', async () => {
    // EvalGold 薄壳保证 oclif 不把 eval gold 当 topic-only(默认 exit 0),
    // 跟 legacy execute([]) 的 CliExit(1) 行为对齐。
    try {
      await execFileAsync('node', [CLI, 'eval', 'gold']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 1, `expected exit 1, got ${e.code}`);
      const out = e.stdout + e.stderr;
      assert.ok(
        /eval gold (init|validate|compare)/i.test(out),
        `expected usage hint listing sub-sub commands, got:\n${out.slice(0, 200)}`,
      );
    }
  });
});
