import type { CliMessageKey } from '../i18n-dict.js';
import { execute as doctor } from './doctor.js';
import { execute as evalCommand } from './eval.js';
import { execute as exportCommand } from './export.js';
import { execute as improve } from './improve.js';
import { execute as init } from './init.js';
import { execute as observe } from './observe.js';
import { execute as studio } from './studio.js';

export interface CommandModule {
  /** i18n key,dispatcher 收到 --help / -h 时打印此 key 的内容并 exit 0。 */
  helpKey: CliMessageKey;
  /** 二级子命令 help。用于 `omk eval gold --help` 这类产品子路径。 */
  subHelp?: Record<string, CliMessageKey>;
  execute: (argv: string[]) => Promise<void>;
}

/** 产品级主命令查表。新增对外命令时,在这里加一行就够。 */
export const PRODUCT_COMMANDS: Record<string, CommandModule> = {
  init:    { helpKey: 'cli.help.product_main', execute: init },
  doctor:  { helpKey: 'cli.help.doctor_usage', execute: doctor },
  eval:    {
    helpKey: 'cli.help.eval',
    subHelp: {
      gold: 'cli.help.eval_gold',
      debias: 'cli.help.eval_debias',
    },
    execute: evalCommand,
  },
  observe: { helpKey: 'cli.help.observe', execute: observe },
  improve: {
    helpKey: 'cli.help.improve',
    subHelp: {
      plan: 'cli.help.improve_plan',
      failures: 'cli.help.improve_failures',
      samples: 'cli.help.improve_samples',
      skill: 'cli.help.improve_skill',
    },
    execute: improve,
  },
  export:  {
    helpKey: 'cli.help.export',
    subHelp: {
      diff: 'cli.help.export_diff',
      verdict: 'cli.help.export_verdict',
      saturation: 'cli.help.export_saturation',
    },
    execute: exportCommand,
  },
  studio:  { helpKey: 'cli.help.studio',  execute: studio },
};
