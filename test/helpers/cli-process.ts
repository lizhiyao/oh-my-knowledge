/**
 * CLI 真子进程 harness：dispatcher、startup、模块加载与进程退出契约的单一 owner。
 * in-process 那一半见 helpers/run-command.ts 的头注释；两边各管一种形态，不合并。
 *
 * 为什么拆两个入口而不是一个 resolve {code, stdout, stderr} 的入口：
 * 期待失败的用例拿到总是 resolve 的结果时，忘记断码就静默永真——
 * 「进程成功即用例失败」必须靠结构保证，不能靠调用方自觉。所以：
 * - runCli         期待 exit 0；非零退出 reject CliProcessError（带 code/stdout/stderr）。
 * - runCliFailing  期待以 expectedCode 退出；exit 0 或码不符都 reject。
 *                  expectedCode 必填、不给默认值——被测字段吞进默认值就看不出用例在测什么。
 *
 * 迁移对照（历史形态 → 本 helper）：
 * - try { await execFileAsync('node', [CLI, ...]); assert.fail('expected non-zero exit'); } catch ...
 *   → await runCliFailing(args, code, options)
 * - assert.rejects(() => execFileAsync('node', [CLI, ...]), e => 断 (e as ExecError).code)
 *   → await runCliFailing(args, code, options)
 * - await execFileAsync('node', [CLI, ...])（期待成功）
 *   → await runCli(args, options)
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录；调用方不再需要各自手搓 __dirname 推 PROJECT_ROOT。 */
export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 编译后的 CLI 入口（dist/cli/index.js）；测其他 node 产物时用 options.entry 覆盖。 */
export const CLI_ENTRY = join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

export interface CliProcessOptions {
  /** node 入口脚本，默认 CLI_ENTRY；测 dist-scripts、worker 或 examples 脚本时覆盖。 */
  entry?: string;
  cwd?: string;
  /** 原样透传给子进程；传了就完全替换，不传则继承当前进程环境（同 execFile 语义）。 */
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  timeout?: number;
}

export interface CliOutput {
  stdout: string;
  stderr: string;
}

/**
 * 子进程结果与期待不符时抛出的错误。code 仅在进程真实以某退出码结束时存在；
 * spawn 失败、被信号杀死、maxBuffer／timeout 触发时 code 为 undefined
 * （那些不是被测退出码，直接判失败，不进入断码路径）。
 */
export class CliProcessError extends Error {
  readonly code: number | undefined;
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, output: CliOutput & { code: number | undefined }) {
    super(message);
    this.name = 'CliProcessError';
    this.code = output.code;
    this.stdout = output.stdout;
    this.stderr = output.stderr;
  }
}

interface RawExit extends CliOutput {
  code: number;
}

/** 诊断消息里的进程标识：仓库内产物用相对路径，仓库外 fixture 用绝对路径。 */
function displayEntry(entry: string): string {
  const rel = relative(PROJECT_ROOT, entry);
  return rel.startsWith('..') ? entry : rel;
}

function spawnNode(entry: string, args: string[], options: CliProcessOptions): Promise<RawExit> {
  // vitest 不会自动 build；entry 缺失时给清晰 hint，避免新人撞 node 的 Cannot find module。
  if (!existsSync(entry)) {
    return Promise.reject(new CliProcessError(
      `entry not found: ${entry} — run \`yarn build:runtime\` first (or check the path)`,
      { code: undefined, stdout: '', stderr: '' },
    ));
  }
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [entry, ...args],
      {
        cwd: options.cwd,
        env: options.env,
        maxBuffer: options.maxBuffer,
        timeout: options.timeout,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        if (typeof error.code === 'number') {
          resolve({ code: error.code, stdout, stderr });
          return;
        }
        const why = error.killed && error.signal ? `killed by ${error.signal}` : String(error.code ?? error.message);
        reject(new CliProcessError(
          `node ${displayEntry(entry)} ${args.join(' ')} did not exit normally: ${why}\nstderr:\n${stderr}`,
          { code: undefined, stdout, stderr },
        ));
      },
    );
  });
}

/** 期待 exit 0：进程以任何非零码退出都 reject CliProcessError。 */
export async function runCli(args: string[], options: CliProcessOptions = {}): Promise<CliOutput> {
  const entry = options.entry ?? CLI_ENTRY;
  const result = await spawnNode(entry, args, options);
  if (result.code !== 0) {
    throw new CliProcessError(
      `${displayEntry(entry)} ${args.join(' ')} exited ${result.code}, expected exit 0\nstderr:\n${result.stderr}`,
      result,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * 期待失败：进程以 expectedCode 退出时 resolve {stdout, stderr}；
 * exit 0（进程成功即用例失败）或退出码不符都 reject CliProcessError。
 */
export async function runCliFailing(
  args: string[],
  expectedCode: number,
  options: CliProcessOptions = {},
): Promise<CliOutput> {
  const entry = options.entry ?? CLI_ENTRY;
  const result = await spawnNode(entry, args, options);
  if (result.code === expectedCode) {
    return { stdout: result.stdout, stderr: result.stderr };
  }
  const got = result.code === 0 ? 'succeeded (exit 0)' : `exited ${result.code}`;
  throw new CliProcessError(
    `${displayEntry(entry)} ${args.join(' ')} ${got}, expected exit ${expectedCode}\nstderr:\n${result.stderr}`,
    result,
  );
}
