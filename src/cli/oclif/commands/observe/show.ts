// oclif 版 observe show — 透传 argv 给生产 executeShow()。

import { Args, Command, Flags } from '@oclif/core';
import { bilingual } from '../../i18n.js';

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
      options: ['zh', 'en'],
      default: 'zh',
      env: 'OMK_LANG',
    }),
    'input-dir': Flags.string({
      description: bilingual({
        zh: 'inbox 数据目录',
        en: 'Inbox data dir',
      }),
    }),
  };

  async run(): Promise<void> {
    await this.parse(ObserveShow);
    const argv = this.argv;
    const { executeShow } = await import('../../../commands/observe.js');
    const { CliExit } = await import('../../../cli-exit.js');
    try {
      await executeShow(argv);
    } catch (err) {
      if (err instanceof CliExit) {
        if (err.code === 0) return;
        this.exit(err.code);
      }
      throw err;
    }
  }
}
