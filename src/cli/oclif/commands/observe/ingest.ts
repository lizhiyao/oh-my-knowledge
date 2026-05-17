// oclif 版 observe ingest — 透传 argv 给生产 executeIngest()。

import { Args, Command, Flags } from '@oclif/core';
import { bilingual } from '../../i18n.js';
import { runLegacyCommand } from '../../run-legacy.js';

export default class ObserveIngest extends Command {
  static description = bilingual({
    zh: '把 trace 目录 ingest 成 observation inbox 报告。',
    en: 'Ingest trace dir into observation inbox report.',
  });

  static args = {
    traceDir: Args.string({
      description: bilingual({
        zh: 'trace 目录路径。',
        en: 'Trace dir path.',
      }),
      required: true,
    }),
  };

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      default: 'zh',
    }),
    'output-dir': Flags.string({
      description: bilingual({
        zh: '输出目录，默认 ~/.oh-my-knowledge/observations',
        en: 'Output dir, default ~/.oh-my-knowledge/observations',
      }),
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ObserveIngest);
    const lang = (flags.lang ?? 'zh') as 'zh' | 'en';
    await runLegacyCommand(this, async () => {
      const { runObserveIngest } = await import('../../../commands/observe.js');
      await runObserveIngest(args, { ...flags, lang }, lang);
    });
  }
}
