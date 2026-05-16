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

async function main(): Promise<void> {
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
