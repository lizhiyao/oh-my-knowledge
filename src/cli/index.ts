#!/usr/bin/env node

import { tCli, getCliLang, parseLangFromArgv, type CliLang } from './i18n.js';
import { checkUpdate } from './update-check.js';
import { BENCH_COMMANDS, DOMAIN_COMMANDS, type CommandModule } from './commands/registry.js';

/**
 * --help / -h 在 argv 任意位置都打印对应 helpKey 内容并 exit 0。
 * 集中在 dispatcher 处理,因为下游 execute 走 parseArgsStrictOrExit,
 * 那一层 strict:true 不识别 --help 会当 unknown option 报错。
 */
function dispatchOrPrintHelp(cmd: CommandModule, argv: string[], lang: CliLang): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(tCli(cmd.helpKey, lang).trim());
    process.exit(0);
  }
  return cmd.execute(argv);
}

async function main(): Promise<void> {
  const lang = getCliLang(parseLangFromArgv(process.argv));
  checkUpdate(lang);
  const [domain, command, ...rest]: string[] = process.argv.slice(2);

  if (!domain || domain === '--help' || domain === '-h') {
    console.log(tCli('cli.help.main', lang).trim());
    process.exit(0);
  }

  // 顶层 domain 命令 (analyze / doctor) 不走 bench 前缀,先于 bench 路由
  const domainCmd = DOMAIN_COMMANDS[domain];
  if (domainCmd) {
    const args = command ? [command, ...rest] : [];
    await dispatchOrPrintHelp(domainCmd, args, lang);
    return;
  }

  if (domain !== 'bench') {
    console.error(tCli('cli.common.unknown_domain', lang, { domain }));
    process.exit(1);
  }

  if (!command || command === '--help' || command === '-h') {
    console.log(tCli('cli.help.main', lang).trim());
    process.exit(0);
  }

  const benchCmd = BENCH_COMMANDS[command];
  if (!benchCmd) {
    console.error(tCli('cli.common.unknown_bench_command', lang, { command }));
    process.exit(1);
  }
  await dispatchOrPrintHelp(benchCmd, rest, lang);
}

main();
