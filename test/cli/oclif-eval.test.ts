/**
 * oclif 路由验收 + eval/gold command 生命周期测试。
 * 帮助、三级路由与 dispatcher 语言选择保留真实进程，其余直接运行源码 Command。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import EvalCommand from '../../src/cli/commands/eval/index.js';
import EvalGoldCompare from '../../src/cli/commands/eval/gold/compare.js';
import EvalGoldInit from '../../src/cli/commands/eval/gold/init.js';
import EvalGoldValidate from '../../src/cli/commands/eval/gold/validate.js';
import { renderCommandHelp, runCommand } from '../helpers/run-command.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

interface ExecError extends Error {
  code?: number;
  stdout: string;
  stderr: string;
}


describe('oclif eval', () => {
  it('eval --help 含 41 flag', async () => {
    const stdout = await renderCommandHelp('eval');
    assert.ok(stdout.includes('跑评测'), `default eval --help missing zh:\n${stdout.slice(0, 200)}`);
    // 抽样核心 flag
    assert.ok(stdout.includes('--control'), 'should list --control');
    assert.ok(stdout.includes('--treatment'), 'should list --treatment');
    assert.ok(stdout.includes('--bootstrap'), 'should list --bootstrap (eval-runner extra)');
    assert.ok(stdout.includes('--no-debias-length'), 'should list --no-debias-length');
    assert.ok(stdout.includes('--threshold'), 'should list --threshold');
  });

  it('eval --help --lang en', async () => {
    const stdout = await renderCommandHelp('eval', 'en');
    assert.ok(stdout.includes('Run evaluation'), 'should contain en description');
  });

  it('eval gold init --help', async () => {
    const stdout = await renderCommandHelp('eval:gold:init');
    assert.ok(stdout.includes('初始化 gold dataset'), `gold init --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('--out'), 'should list --out');
    assert.ok(stdout.includes('--annotator'), 'should list --annotator');
  });

  it('eval gold validate --help', async () => {
    const stdout = await renderCommandHelp('eval:gold:validate');
    assert.ok(stdout.includes('校验 gold dataset'), `gold validate --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('DIR'), 'should list DIR positional');
  });

  it('eval gold compare --help', async () => {
    const stdout = await renderCommandHelp('eval:gold:compare');
    assert.ok(stdout.includes('evaluation report 跟 gold dataset 对比'), `gold compare --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('REPORTID'), 'should list REPORTID positional');
    assert.ok(stdout.includes('--gold-dir'), 'should list --gold-dir');
  });

  it('eval gold init + validate 实跑', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-oclif-gold-'));
    try {
      const out = join(dir, 'gold');
      const init = await runCommand(EvalGoldInit, ['--out', out, '--annotator', 'human-team']);
      assert.ok(init.stdout.includes('metadata.yaml'));
      assert.ok(existsSync(join(out, 'metadata.yaml')), 'metadata.yaml not created');
      assert.ok(existsSync(join(out, 'annotations.yaml')), 'annotations.yaml not created');
      const validate = await runCommand(EvalGoldValidate, [out]);
      assert.ok(validate.stdout.includes('gold dataset OK'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('eval gold validate 缺 positional → exit 2(oclif required-args)', async () => {
    // required: true 之后 oclif 自己出 Missing 1 required arg + exit 2(对齐
    // package.json oclif.exitCodes.requiredArgs)。原来 exit 1 是 legacy
    // execute() throw CliExit(1) 的行为,迁 oclif 后由 oclif 接管。
    try {
      await runCommand(EvalGoldValidate, []);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}`);
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

  it('eval 找不到 samples 时输出友好错误而不是裸 ENOENT', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-eval-no-samples-'));
    try {
      await mkdir(join(dir, 'skills', 'review'), { recursive: true });
      await writeFile(join(dir, 'skills', 'review', 'SKILL.md'), '你是一个测试用的代码审查 skill，内容足够长。');

      await assert.rejects(
        () => runCommand(EvalCommand, [
          '--control', 'baseline',
          '--treatment', 'review',
          '--skill-dir', 'skills',
          '--skip-doctor',
          '--no-serve',
          '--lang', 'zh',
        ], { cwd: dir }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1, `expected exit 1, got ${e.code}`);
          assert.ok(e.stderr.includes('未找到评测用例'), e.stderr);
          assert.ok(e.stderr.includes('下一步'), e.stderr);
          assert.ok(e.stderr.includes('omk sample skills/review'), e.stderr);
          assert.ok(!e.stderr.includes('ENOENT'), e.stderr);
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('eval 发现目录 skill 旧 eval-samples 路径时提示迁移到 .omk/samples.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-eval-deprecated-samples-'));
    try {
      const skillRoot = join(dir, 'skills', 'review');
      await mkdir(skillRoot, { recursive: true });
      await writeFile(join(skillRoot, 'SKILL.md'), '你是一个测试用的代码审查 skill，内容足够长。');
      await writeFile(join(skillRoot, 'eval-samples.json'), JSON.stringify([
        { sample_id: 's1', prompt: 'review legacy samples location' },
      ]));

      await assert.rejects(
        () => runCommand(EvalCommand, [
          '--control', 'baseline',
          '--treatment', 'review',
          '--skill-dir', 'skills',
          '--skip-doctor',
          '--no-serve',
          '--lang', 'zh',
        ], { cwd: dir }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1, `expected exit 1, got ${e.code}`);
          assert.ok(e.stderr.includes('发现旧的目录 skill 用例位置'), e.stderr);
          assert.ok(e.stderr.includes(join(skillRoot, 'eval-samples.json')), e.stderr);
          assert.ok(e.stderr.includes(join(skillRoot, '.omk', 'samples.json')), e.stderr);
          assert.ok(!e.stderr.includes('omk sample skills/review'), e.stderr);
          assert.ok(!e.stderr.includes('ENOENT'), e.stderr);
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('eval gold compare 非法 --bootstrap-samples → exit 2 + 中文 parser 错误', async () => {
    try {
      await runCommand(EvalGoldCompare, ['report-1', '--bootstrap-samples', '10']);
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
