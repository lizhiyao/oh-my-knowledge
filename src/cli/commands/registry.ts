import type { CliMessageKey } from '../i18n-dict.js';
import { execute as analyze } from './analyze.js';
import { execute as debiasValidate } from './debias-validate.js';
import { execute as diagnose } from './diagnose.js';
import { execute as diff } from './diff.js';
import { execute as doctor } from './doctor.js';
import { execute as evolve } from './evolve.js';
import { execute as failures } from './failures.js';
import { execute as gate } from './gate.js';
import { execute as genSamples } from './gen-samples.js';
import { execute as gold } from './gold.js';
import { execute as init } from './init.js';
import { execute as report } from './report.js';
import { execute as run } from './run.js';
import { execute as saturation } from './saturation.js';
import { execute as verdict } from './verdict.js';

export interface CommandModule {
  /** i18n key,dispatcher 收到 --help / -h 时打印此 key 的内容并 exit 0。 */
  helpKey: CliMessageKey;
  execute: (argv: string[]) => Promise<void>;
}

/** `omk bench <name>` 子命令查表。新增子命令时,在这里加一行就够。 */
export const BENCH_COMMANDS: Record<string, CommandModule> = {
  run:               { helpKey: 'cli.help.main',            execute: run },
  report:            { helpKey: 'cli.help.main',            execute: report },
  init:              { helpKey: 'cli.help.main',            execute: init },
  gate:              { helpKey: 'cli.help.main',            execute: gate },
  'gen-samples':     { helpKey: 'cli.help.main',            execute: genSamples },
  evolve:            { helpKey: 'cli.help.main',            execute: evolve },
  diff:              { helpKey: 'cli.help.diff_usage',      execute: diff },
  gold:              { helpKey: 'cli.help.gold',            execute: gold },
  'debias-validate': { helpKey: 'cli.help.debias_validate', execute: debiasValidate },
  saturation:        { helpKey: 'cli.help.saturation',      execute: saturation },
  verdict:           { helpKey: 'cli.help.verdict',         execute: verdict },
  diagnose:          { helpKey: 'cli.help.diagnose',        execute: diagnose },
  failures:          { helpKey: 'cli.help.failures',        execute: failures },
};

/** 顶层 domain 命令 (`omk analyze` / `omk doctor`),不走 bench 前缀。 */
export const DOMAIN_COMMANDS: Record<string, CommandModule> = {
  analyze: { helpKey: 'cli.help.analyze_usage', execute: analyze },
  doctor:  { helpKey: 'cli.help.doctor_usage',  execute: doctor },
};
