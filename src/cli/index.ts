#!/usr/bin/env node

import { getCliLang, parseLangFromArgv } from './i18n.js';
import { checkUpdate } from './update-check.js';
import { CliExit } from './cli-exit.js';

// CLI 入口:lang / 版本提醒等共享前置逻辑跑完,把控制权交给 oclif dispatcher。
// 所有命令统一走 src/cli/oclif/commands/* 下的 oclif Command。
//
// 业务 execute() 函数仍住在 src/cli/commands/*.ts,oclif Command 是薄壳:
// 解析 flag 给 oclif --help 用,然后透传 argv 调对应 legacy execute()。

// --help / --version / -h / -v 走短路径,不应当被网络 I/O 拖慢。oclif 走完
// --help 路径自然 resolve 不调 process.exit,unawaited fetch 会把 event
// loop 拖住 ~1s(worst case AbortSignal.timeout 3s)。短路径整体 skip checkUpdate。
const SHORT_PATH_FLAGS = ['--help', '-h', '--version', '-v'];
function isShortPath(argv: readonly string[]): boolean {
  return argv.some((a) => SHORT_PATH_FLAGS.includes(a));
}

/**
 * legacy CLI 支持 `omk --lang en eval --help` 这种把 lang 放在子命令前的写法
 * (parseLangFromArgv 跨整 argv scan)。oclif 默认 parser 把第一个非 flag 当
 * 命令 id,顶层位置的 --lang 跟它的 value 会让 oclif 找错 command。这里跨整
 * argv 抽 --lang / --lang=VAL 到末尾,跟 legacy 行为对齐(再由子命令 parse 用)。
 */
function normalizeArgv(argv: readonly string[]): string[] {
  if (argv.length < 3) return [...argv];
  const userArgs = argv.slice(2);
  const langTokens: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < userArgs.length; i++) {
    const tok = userArgs[i]!;
    if (tok === '--lang') {
      langTokens.push(tok);
      if (i + 1 < userArgs.length) {
        langTokens.push(userArgs[i + 1]!);
        i++;
      }
    } else if (tok.startsWith('--lang=')) {
      langTokens.push(tok);
    } else {
      rest.push(tok);
    }
  }
  if (langTokens.length === 0) return [...argv];
  return [argv[0]!, argv[1]!, ...rest, ...langTokens];
}

async function main(): Promise<void> {
  process.argv = normalizeArgv(process.argv);
  const lang = getCliLang(parseLangFromArgv(process.argv));
  if (!isShortPath(process.argv)) {
    checkUpdate(lang);
  }

  const { runOclifPath } = await import('./oclif/run.js');
  await runOclifPath();
}

main().catch((err: unknown) => {
  if (err instanceof CliExit) {
    process.exit(err.code);
  }
  console.error(err);
  process.exit(1);
});
