#!/usr/bin/env node

import { tCli, getCliLang, parseLangFromArgv, type CliLang } from './i18n.js';
import type { CliMessageKey } from './i18n-dict.js';
import { checkUpdate } from './update-check.js';
import { CliExit } from './cli-exit.js';
import { PRODUCT_COMMANDS, type CommandModule } from './commands/registry.js';

/**
 * --help / -h 在 argv 任意位置都打印对应 helpKey 内容并 exit 0。
 * 集中在 dispatcher 处理,因为下游 execute 走 parseArgsStrictOrExit,
 * 那一层 strict:true 不识别 --help 会当 unknown option 报错。
 */
function helpKeyFor(cmd: CommandModule, argv: string[]): CliMessageKey {
  if (!cmd.subHelp) return cmd.helpKey;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token || token === '--help' || token === '-h') continue;
    if (token === '--lang') {
      i++;
      continue;
    }
    if (token.startsWith('--lang=')) continue;
    if (token.startsWith('-')) continue;
    return cmd.subHelp[token] ?? cmd.helpKey;
  }
  return cmd.helpKey;
}

function dispatchOrPrintHelp(cmd: CommandModule, argv: string[], lang: CliLang): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(tCli(helpKeyFor(cmd, argv), lang).trim());
    throw new CliExit(0);
  }
  return cmd.execute(argv);
}

async function main(): Promise<void> {
  const lang = getCliLang(parseLangFromArgv(process.argv));
  checkUpdate(lang);

  // OMK_CLI_NEXT=1 切到 oclif dispatcher(PR-B dogfood 模式)。
  // legacy 路径完全不动,默认行为零变化。oclif 路径只迁了 doctor / sample 两个命令,
  // 其它命令在该模式下会报「command not found」exit 1(跟 legacy unknown_domain 行为对得齐)。
  if (process.env.OMK_CLI_NEXT === '1') {
    const { runOclifPath } = await import('./oclif/run.js');
    await runOclifPath();
    return;
  }

  const [command, ...rest]: string[] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    console.log(tCli('cli.help.product_main', lang).trim());
    throw new CliExit(0);
  }

  const cmd = PRODUCT_COMMANDS[command];
  if (!cmd) {
    console.error(tCli('cli.common.unknown_domain', lang, { domain: command }));
    throw new CliExit(1);
  }
  await dispatchOrPrintHelp(cmd, rest, lang);
}

main().catch((err: unknown) => {
  // CliExit = 命令显式终止(--help / 业务失败 / parse 错误等),透传 exit code。
  // 其他 throw 是未处理的运行时错误,打印 stack 后 exit 1。
  if (err instanceof CliExit) {
    process.exit(err.code);
  }
  console.error(err);
  process.exit(1);
});
