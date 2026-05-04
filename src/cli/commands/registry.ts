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
  execute: (argv: string[]) => Promise<void>;
}

/** `omk bench <name>` 子命令查表。新增子命令时,在这里加一行就够。 */
export const BENCH_COMMANDS: Record<string, CommandModule> = {
  run:               { execute: run },
  report:            { execute: report },
  init:              { execute: init },
  gate:              { execute: gate },
  'gen-samples':     { execute: genSamples },
  evolve:            { execute: evolve },
  diff:              { execute: diff },
  gold:              { execute: gold },
  'debias-validate': { execute: debiasValidate },
  saturation:        { execute: saturation },
  verdict:           { execute: verdict },
  diagnose:          { execute: diagnose },
  failures:          { execute: failures },
};

/** 顶层 domain 命令 (`omk analyze` / `omk doctor`),不走 bench 前缀。 */
export const DOMAIN_COMMANDS: Record<string, CommandModule> = {
  analyze: { execute: analyze },
  doctor:  { execute: doctor },
};
