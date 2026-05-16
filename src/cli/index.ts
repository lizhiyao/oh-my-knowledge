#!/usr/bin/env node

import { getCliLang, parseLangFromArgv, tCli } from './i18n.js';
import { checkUpdate } from './update-check.js';
import { CliExit } from './cli-exit.js';

// CLI 入口:lang / 版本提醒等共享前置逻辑跑完,把控制权交给 oclif dispatcher。
// 例外:`omk`(无子命令,只带可选 --lang)时打 cli.help.product_main 双语
// prose 后 exit — oclif 默认的 VERSION/USAGE/TOPICS 列表对中文用户和新用户
// 都太 terse,product_main 段教学性更强(用法 / 主路径 / 通用选项)。
//
// 业务 execute() 函数仍住在 src/cli/commands/*.ts,oclif Command 是薄壳:
// 解析 flag 给 oclif --help 用,然后透传 argv 调对应 legacy execute()。

/** 判断 argv 是否只剩 `--lang [zh|en]`(及其 `--lang=...` 形式)— 即 bare invocation。 */
function isBareInvocation(argv: readonly string[]): boolean {
  // argv = process.argv.slice(2),即去掉 node + script path 后的用户输入。
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (token === '--lang') {
      i++; // 跳过 --lang 的 value
      continue;
    }
    if (token.startsWith('--lang=')) continue;
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  const lang = getCliLang(parseLangFromArgv(process.argv));
  checkUpdate(lang);

  if (isBareInvocation(process.argv.slice(2))) {
    process.stdout.write(tCli('cli.help.product_main', lang).trim() + '\n');
    return;
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
