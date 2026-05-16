/**
 * oclif 路径 eval + 3 gold sub-sub 命令验收(OMK_CLI_NEXT=1)。
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

const OCLIF_ENV = { ...process.env, OMK_CLI_NEXT: '1' };

describe('oclif eval (OMK_CLI_NEXT=1)', () => {
  it('eval --help 含 41 flag', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', '--help'], { env: OCLIF_ENV });
    assert.ok(stdout.includes('跑评测'), `default eval --help missing zh:\n${stdout.slice(0, 200)}`);
    // 抽样核心 flag
    assert.ok(stdout.includes('--control'), 'should list --control');
    assert.ok(stdout.includes('--treatment'), 'should list --treatment');
    assert.ok(stdout.includes('--bootstrap'), 'should list --bootstrap (eval-runner extra)');
    assert.ok(stdout.includes('--no-debias-length'), 'should list --no-debias-length');
    assert.ok(stdout.includes('--threshold'), 'should list --threshold');
  });

  it('eval --help --lang en', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', '--help', '--lang', 'en'], { env: OCLIF_ENV });
    assert.ok(stdout.includes('Run evaluation'), 'should contain en description');
  });

  it('eval gold init --help', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', 'gold', 'init', '--help'], { env: OCLIF_ENV });
    assert.ok(stdout.includes('初始化 gold dataset'), `gold init --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('--out'), 'should list --out');
    assert.ok(stdout.includes('--annotator'), 'should list --annotator');
  });

  it('eval gold validate --help', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', 'gold', 'validate', '--help'], { env: OCLIF_ENV });
    assert.ok(stdout.includes('校验 gold dataset'), `gold validate --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('DIR'), 'should list DIR positional');
  });

  it('eval gold compare --help', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', 'gold', 'compare', '--help'], { env: OCLIF_ENV });
    assert.ok(stdout.includes('evaluation report 跟 gold dataset 对比'), `gold compare --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('REPORTID'), 'should list REPORTID positional');
    assert.ok(stdout.includes('--gold-dir'), 'should list --gold-dir');
  });

  it('eval gold init 实跑(tmpdir 生成 3 文件)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-oclif-gold-'));
    try {
      const out = join(dir, 'gold');
      await execFileAsync('node', [CLI, 'eval', 'gold', 'init', '--out', out], { env: OCLIF_ENV });
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
      await execFileAsync('node', [CLI, 'eval', 'gold', 'validate'], { env: OCLIF_ENV });
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}`);
    }
  });

  it('eval unknown flag → exit 2', async () => {
    try {
      await execFileAsync('node', [CLI, 'eval', '--bogus'], { env: OCLIF_ENV });
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2);
    }
  });
});
