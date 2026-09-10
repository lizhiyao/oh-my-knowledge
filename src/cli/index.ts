#!/usr/bin/env node

import { getCliLang, parseLangFromArgv } from './lib/i18n.js';
import { CliExit } from './lib/cli-exit.js';

// CLI 入口:lang / 版本提醒等共享前置逻辑跑完,把控制权交给 oclif dispatcher。
// 所有命令统一走 src/cli/commands/* 下的 oclif Command。

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
    const { checkUpdate } = await import('./lib/update-check.js');
    checkUpdate(lang);
  }

  const { runOclifPath } = await import('./oclif/run.js');
  await runOclifPath();
}

main().catch(async (err: unknown) => {
  const code = err instanceof CliExit ? err.code : 1;
  if (!(err instanceof CliExit)) console.error(err);
  // Await both channels after the dispatcher has emitted its final diagnostics.
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((resolve, reject) => {
    stream.write('', (error) => error ? reject(error) : resolve());
  }))).catch(() => { process.exit(1); });
  process.exit(code);
});
