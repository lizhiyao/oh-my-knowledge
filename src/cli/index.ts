#!/usr/bin/env node

import { tCli, getCliLang, parseLangFromArgv } from './i18n.js';
import { checkUpdate } from './update-check.js';
import { BENCH_COMMANDS, DOMAIN_COMMANDS } from './commands/registry.js';

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
    await domainCmd.execute(args);
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
  await benchCmd.execute(rest);
}

main();
