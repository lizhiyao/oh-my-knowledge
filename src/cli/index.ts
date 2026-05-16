#!/usr/bin/env node

import { getCliLang, parseLangFromArgv } from './i18n.js';
import { checkUpdate } from './update-check.js';
import { CliExit } from './cli-exit.js';

// CLI 入口:lang / 版本提醒等共享前置逻辑跑完,把控制权交给 oclif dispatcher。
// legacy PRODUCT_COMMANDS 查表 + cli.help.product_main prose 已于 PR-C(issue #109)
// 移除;所有命令现在统一走 src/cli/oclif/commands/* 下的 oclif Command。
//
// 业务 execute() 函数仍住在 src/cli/commands/*.ts,oclif Command 是薄壳:
// 解析 flag 给 oclif --help 用,然后透传 argv 调对应 legacy execute()。

async function main(): Promise<void> {
  const lang = getCliLang(parseLangFromArgv(process.argv));
  checkUpdate(lang);

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
