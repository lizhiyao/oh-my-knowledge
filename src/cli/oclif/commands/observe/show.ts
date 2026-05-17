// oclif 版 observe show — 透传 argv 给生产 executeShow()。

import { Args, Command, Flags } from '@oclif/core';
import { bilingual } from '../../i18n.js';
import { runLegacyCommand } from '../../run-legacy.js';

export default class ObserveShow extends Command {
  static description = bilingual({
    zh: '展开 observation inbox 中某条 item 的详情。',
    en: 'Show details of a specific observation inbox item.',
  });

  static args = {
    inboxId: Args.string({
      description: bilingual({
        zh: 'inbox item ID。',
        en: 'Inbox item ID.',
      }),
      required: true,
    }),
  };

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      default: 'zh',
    }),
    'input-dir': Flags.string({
      description: bilingual({
        zh: 'inbox 数据目录',
        en: 'Inbox data dir',
      }),
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ObserveShow);
    const lang = (flags.lang ?? 'zh') as 'zh' | 'en';
    await runLegacyCommand(this, async () => {
      const { runObserveShow } = await import('../../../commands/observe.js');
      await runObserveShow(args, { ...flags, lang }, lang);
    });
  }
}
