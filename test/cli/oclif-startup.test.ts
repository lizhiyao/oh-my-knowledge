/**
 * --help / --version 短路径不被 checkUpdate fetch 拖慢的回归测试。
 * 用一个保证不可达的 `npm_config_registry`(127.0.0.1:1)模拟最坏情况,
 * 确认 short-circuit 把 update fetch 跳掉,event loop 不被 unawaited fetch 拖住。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

interface ExecError extends Error {
  code?: number;
  stdout: string;
  stderr: string;
}

/**
 * 用一个保证不可达的 registry 让 fetch 走满 timeout。如果短路径生效,
 * --help 会在网络 I/O 之前 resolve;反之会被拖到 ~3s timeout。
 * 阈值给得宽松(800ms),既能挡住 1100ms 回归又不被偶发 GC / IO 抖动误判。
 */
const HOSTILE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  USER: process.env.USER,
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG,
  npm_config_registry: 'http://127.0.0.1:1/',
};
const STARTUP_BUDGET_MS = 800;

async function timed(args: string[]): Promise<number> {
  const t0 = Date.now();
  await execFileAsync('node', [CLI, ...args], { env: HOSTILE_ENV });
  return Date.now() - t0;
}

describe('oclif startup short-circuit (skip checkUpdate on --help/--version)', () => {
  it(`--help 在 ${STARTUP_BUDGET_MS}ms 内完成(不被 checkUpdate fetch 拖)`, async () => {
    const ms = await timed(['--help']);
    assert.ok(
      ms < STARTUP_BUDGET_MS,
      `--help took ${ms}ms, expected < ${STARTUP_BUDGET_MS}ms (regression: checkUpdate fetch should be skipped on short path)`,
    );
  });

  it(`--version 在 ${STARTUP_BUDGET_MS}ms 内完成`, async () => {
    const ms = await timed(['--version']);
    assert.ok(
      ms < STARTUP_BUDGET_MS,
      `--version took ${ms}ms, expected < ${STARTUP_BUDGET_MS}ms`,
    );
  });

  it(`doctor --help 在 ${STARTUP_BUDGET_MS}ms 内完成(子命令 --help 同样走短路径)`, async () => {
    const ms = await timed(['doctor', '--help']);
    assert.ok(
      ms < STARTUP_BUDGET_MS,
      `doctor --help took ${ms}ms, expected < ${STARTUP_BUDGET_MS}ms`,
    );
  });

  it(`-h 短开关跟 --help 等价(走 oclif additionalHelpFlags)`, async () => {
    const { stdout } = await execFileAsync('node', [CLI, '-h']);
    assert.ok(stdout.includes('\nUSAGE\n'), `expected oclif USAGE block on -h, got:\n${stdout.slice(0, 200)}`);
  });

  it(`-v 短开关跟 --version 等价`, async () => {
    const { stdout } = await execFileAsync('node', [CLI, '-v']);
    assert.ok(/\d+\.\d+\.\d+/.test(stdout), `expected version string on -v, got: ${stdout}`);
  });

  it(`eval -h 走 oclif help(不再报 -h not found)`, async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', '-h']);
    assert.ok(stdout.includes('\nUSAGE\n'), 'eval -h should print oclif USAGE');
    assert.ok(stdout.includes('--control'), 'eval -h should list --control flag');
  });

  it(`OMK_LANG=en_US ambient 不让 oclif parse exit 2(走 legacy fallback)`, async () => {
    // legacy getCliLang 对不支持的 OMK_LANG 值 fallback to zh,oclif lang flag
    // 不应该把 env / 显式 flag 当 enum 校验。回归 PR #120 引入的 env+options 写法。
    const env = { ...process.env, OMK_LANG: 'en_US' };
    const { stdout } = await execFileAsync('node', [CLI, 'doctor', '--help'], { env });
    assert.ok(stdout.includes('\nUSAGE\n'), 'doctor --help should succeed under OMK_LANG=en_US, got: ' + stdout.slice(0, 200));
  });

  it(`显式 --lang fr 不被 oclif enum 拦(legacy fallback to zh)`, async () => {
    // legacy getCliLang 的契约:unsupported lang fallback to zh,不是 exit。
    // oclif lang flag 不应当 enum 校验。
    const { existsSync, rmSync } = await import('node:fs');
    const dir = '/tmp/omk-startup-lang-fr-test';
    rmSync(dir, { recursive: true, force: true });
    try {
      await execFileAsync('node', [CLI, 'init', dir, '--lang', 'fr']);
      assert.ok(existsSync(dir), `init --lang fr should fallback to zh and succeed, dir ${dir} should exist`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(`OMK_LANG=en 业务路径走英文(documented --lang flag > OMK_LANG > zh 优先级)`, async () => {
    // 回归 PR #124 typed input 后的 bug:oclif lang flag 设了 default 'zh',
    // 业务层 `flags.lang ?? 'zh'` 永远拿到 'zh',OMK_LANG=en 被绕过。修复:业务
    // 层走 resolveLang(process.argv) 跟 LangAwareHelp 一致,优先级 CLI > env > zh。
    const env = { ...process.env, OMK_LANG: 'en' };
    try {
      await execFileAsync('node', [CLI, 'doctor', '/tmp/no-such-skill-omk-env-test'], { env });
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      const out = e.stdout + e.stderr;
      assert.ok(/No skills found/.test(out), `OMK_LANG=en should yield English error, got:\n${out.slice(0, 300)}`);
      assert.ok(!/未在.*下发现 skill 文件/.test(out), `OMK_LANG=en should not leak zh error:\n${out.slice(0, 300)}`);
    }
  });

  it(`显式 --lang zh 覆盖 OMK_LANG=en(CLI flag 优先级最高)`, async () => {
    const env = { ...process.env, OMK_LANG: 'en' };
    try {
      await execFileAsync('node', [CLI, 'doctor', '/tmp/no-such-skill-omk-env-test', '--lang', 'zh'], { env });
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      const out = e.stdout + e.stderr;
      assert.ok(/未在.*下发现 skill 文件/.test(out), `--lang zh should override OMK_LANG=en, got:\n${out.slice(0, 300)}`);
    }
  });

  it(`eval --bogus-flag 错误路径 exit 2(parse fail 回归)`, async () => {
    try {
      await execFileAsync('node', [CLI, 'eval', '--bogus-flag']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2 on unknown flag, got ${e.code}`);
    }
  });

  it(`[BREAKING-CLI] 顶层 --lang 不再 dispatch 到 subcommand(normalizeArgv 已删)`, async () => {
    // PR #124 删 normalizeArgv 后,oclif 看 argv[0]=--lang 作 unknown command。
    // legacy `omk --lang en doctor /tmp/x` 形态需改 `omk doctor --lang en /tmp/x`。
    try {
      await execFileAsync('node', [CLI, '--lang', 'en', 'doctor', '/tmp/no-such-skill']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      const out = e.stdout + e.stderr;
      assert.ok(/command --lang not found/.test(out), `expected oclif unknown command on top-level --lang, got:\n${out.slice(0, 300)}`);
    }
  });

  it(`[BREAKING-CLI] 顶层 --lang en <cmd> --help 退化到 root help`, async () => {
    // 等价 case:`omk --lang en doctor --help` 之前(normalizeArgv 存在时)走
    // doctor 英文 help;PR #124 删后 oclif 拿 --lang 作 unknown command,
    // 走 root help fallback(oclif 默认行为)。锁住这条 BREAKING,防新人以为是 bug。
    const { stdout } = await execFileAsync('node', [CLI, '--lang', 'en', 'doctor', '--help']);
    assert.ok(/Evaluation framework for LLM/.test(stdout), `expected root help fallback, got:\n${stdout.slice(0, 300)}`);
    // root help USAGE 是 `$ omk [COMMAND]`,doctor --help 的 USAGE 是 `$ omk doctor [TARGET]`;
    // root help 还有 COMMANDS section 列所有 cmd,doctor --help 没有。用 USAGE 特征区分。
    assert.ok(/\$ omk \[COMMAND\]/.test(stdout), `expected root USAGE \`$ omk [COMMAND]\`, got:\n${stdout.slice(0, 300)}`);
    assert.ok(!/\$ omk doctor/.test(stdout), `should NOT dispatch to doctor USAGE, got:\n${stdout.slice(0, 300)}`);
  });

  it(`[BREAKING-CLI] eval --bogus-flag 错误路径 FLAGS dump 双语并列(init hook 已删)`, async () => {
    // PR #124 删 oclif init hook description mutate 后,oclif core 的
    // `errors/handle.js:L44` 硬编码 `new Help(config)` 不走 LangAwareHelp,
    // dump 出来的是原 `${zh}\n${en}` 双语 sentinel。--lang en / OMK_LANG=en 都不能避开。
    // 锁住已知限制,防新人以为是 i18n 漏切语言。
    try {
      await execFileAsync('node', [CLI, 'eval', '--bogus-flag', '--lang', 'en']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      const out = e.stdout + e.stderr;
      assert.ok(/batch 模式/.test(out) && /Batch mode/.test(out),
        `expected bilingual flag dump (zh + en), got:\n${out.slice(0, 600)}`);
    }
  });

  it(`omk eval gold --lang en 打英文 usage(显式 lang flag 生效)`, async () => {
    try {
      await execFileAsync('node', [CLI, 'eval', 'gold', '--lang', 'en']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 1, `expected exit 1, got ${e.code}`);
      const out = e.stdout + e.stderr;
      assert.ok(/manage human-gold/i.test(out), `expected en usage, got:\n${out.slice(0, 200)}`);
      assert.ok(!out.includes('管理 human-gold'), 'en mode should not leak zh usage');
    }
  });
});
