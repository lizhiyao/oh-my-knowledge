// oclif 版 eval gold init — 透传 argv 给生产 executeInit()。

import { Command, Flags } from '@oclif/core';
import { bilingual, resolveLang } from '../../../i18n.js';
import { runLegacyCommand } from '../../../run-legacy.js';

export default class EvalGoldInit extends Command {
  static description = bilingual({
    zh: '初始化 gold dataset 目录（human-gold 标注集脚手架）。',
    en: 'Init gold dataset dir (scaffold for human-gold annotations).',
  });

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      default: 'zh',
    }),
    out: Flags.string({
      description: bilingual({
        zh: '输出目录，默认 ./gold-dataset',
        en: 'Output dir, default ./gold-dataset',
      }),
      default: './gold-dataset',
    }),
    annotator: Flags.string({
      description: bilingual({
        zh: '标注者名，写入 metadata.yaml',
        en: 'Annotator name, written to metadata.yaml',
      }),
    }),
  };

  async run(): Promise<void> {
    await this.parse(EvalGoldInit);
    const lang = resolveLang(process.argv);
    await runLegacyCommand(this, async () => {
      const { executeInit } = await import('../../../../commands/eval-gold.js');
      await executeInit(this.argv, lang);
    });
  }
}
