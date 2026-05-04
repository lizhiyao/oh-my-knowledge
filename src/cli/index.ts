#!/usr/bin/env node

import { tCli, getCliLang, parseLangFromArgv } from './i18n.js';
import { checkUpdate } from './update-check.js';
import { execute as runCommand } from './commands/run.js';
import { execute as reportCommand } from './commands/report.js';
import { execute as initCommand } from './commands/init.js';
import { execute as gateCommand } from './commands/gate.js';
import { execute as genSamplesCommand } from './commands/gen-samples.js';
import { execute as evolveCommand } from './commands/evolve.js';
import { execute as diffCommand } from './commands/diff.js';
import { execute as goldCommand } from './commands/gold.js';
import { execute as debiasValidateCommand } from './commands/debias-validate.js';
import { execute as saturationCommand } from './commands/saturation.js';
import { execute as verdictCommand } from './commands/verdict.js';
import { execute as diagnoseCommand } from './commands/diagnose.js';
import { execute as failuresCommand } from './commands/failures.js';
import { execute as analyzeCommand } from './commands/analyze.js';
import { execute as doctorCommand } from './commands/doctor.js';

async function main(): Promise<void> {
  const lang = getCliLang(parseLangFromArgv(process.argv));
  checkUpdate(lang);
  const [domain, command, ...rest]: string[] = process.argv.slice(2);

  if (!domain || domain === '--help' || domain === '-h') {
    console.log(tCli('cli.help.main', lang).trim());
    process.exit(0);
  }

  if (domain === 'analyze') {
    const args = command ? [command, ...rest] : [];
    await analyzeCommand(args);
    return;
  }

  if (domain === 'doctor') {
    const args = command ? [command, ...rest] : [];
    await doctorCommand(args);
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

  switch (command) {
    case 'run':
      await runCommand(rest);
      break;
    case 'report':
      await reportCommand(rest);
      break;
    case 'init':
      await initCommand(rest);
      break;
    case 'gate':
      await gateCommand(rest);
      break;
    case 'gen-samples':
      await genSamplesCommand(rest);
      break;
    case 'evolve':
      await evolveCommand(rest);
      break;
    case 'diff':
      await diffCommand(rest);
      break;
    case 'gold':
      await goldCommand(rest);
      break;
    case 'debias-validate':
      await debiasValidateCommand(rest);
      break;
    case 'saturation':
      await saturationCommand(rest);
      break;
    case 'verdict':
      await verdictCommand(rest);
      break;
    case 'diagnose':
      await diagnoseCommand(rest);
      break;
    case 'failures':
      await failuresCommand(rest);
      break;
    default:
      console.error(tCli('cli.common.unknown_bench_command', lang, { command }));
      process.exit(1);
  }
}

main();
