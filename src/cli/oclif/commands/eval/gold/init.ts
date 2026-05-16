import { Command, Flags } from '@oclif/core';
import { bilingual, resolveLang } from '../../../i18n.js';

export default class EvalGoldInit extends Command {
  static description = bilingual({
    zh: '初始化 gold dataset 目录(human-gold 标注集脚手架)。',
    en: 'Init gold dataset dir (scaffold for human-gold annotations).',
  });

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      options: ['zh', 'en'],
      default: 'zh',
      env: 'OMK_LANG',
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
    // process.argv = [node, script, 'eval', 'gold', 'init', ...args] → slice(5)
    const rest = process.argv.slice(5);
    const lang = resolveLang(process.argv);
    const { executeInit } = await import('../../../../commands/eval-gold.js');
    const { CliExit } = await import('../../../../cli-exit.js');
    try {
      await executeInit(rest, lang);
    } catch (err) {
      if (err instanceof CliExit) {
        if (err.code === 0) return;
        this.exit(err.code);
      }
      throw err;
    }
  }
}
