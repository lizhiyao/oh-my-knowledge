// oclif 版 eval gold validate — 透传 argv 给生产 executeValidate()。

import { Args, Command, Flags } from '@oclif/core';
import { bilingual, resolveLang } from '../../../i18n.js';
import { runLegacyCommand } from '../../../run-legacy.js';

export default class EvalGoldValidate extends Command {
  static description = bilingual({
    zh: '校验 gold dataset 目录格式（annotations.yaml schema）。',
    en: 'Validate gold dataset dir (annotations.yaml schema).',
  });

  static args = {
    dir: Args.string({
      description: bilingual({
        zh: 'gold dataset 目录。',
        en: 'Gold dataset dir.',
      }),
      required: true,
    }),
  };

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      default: 'zh',
    }),
  };

  async run(): Promise<void> {
    await this.parse(EvalGoldValidate);
    const lang = resolveLang(process.argv);
    await runLegacyCommand(this, async () => {
      const { executeValidate } = await import('../../../../commands/eval-gold.js');
      await executeValidate(this.argv, lang);
    });
  }
}
