import type { CliMessageKey } from '../i18n-dict.js';
import { execute as doctor } from './doctor.js';
import { execute as evalCommand } from './eval.js';
import { execute as evolve } from './evolve.js';
import { execute as init } from './init.js';
import { execute as observe } from './observe.js';
import { execute as sample } from './sample.js';
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
  init:    { helpKey: 'cli.help.init_usage', execute: init },
  doctor:  { helpKey: 'cli.help.doctor_usage', execute: doctor },
  eval:    {
    helpKey: 'cli.help.eval',
    subHelp: {
      gold: 'cli.help.eval_gold',
    },
    execute: evalCommand,
  },
  observe: {
    helpKey: 'cli.help.observe',
    subHelp: {
      ingest: 'cli.help.observe_ingest',
      inbox: 'cli.help.observe_inbox',
      show: 'cli.help.observe_show',
    },
    execute: observe,
  },
  evolve:  { helpKey: 'cli.help.evolve', execute: evolve },
  sample:  { helpKey: 'cli.help.sample', execute: sample },
  studio:  { helpKey: 'cli.help.studio',  execute: studio },
};
