import { Args, Command, Flags } from '@oclif/core';
import { bilingual, resolveLang } from '../../../i18n.js';

export default class EvalGoldValidate extends Command {
  static description = bilingual({
    zh: '校验 gold dataset 目录格式(annotations.yaml schema)。',
    en: 'Validate gold dataset dir (annotations.yaml schema).',
  });

  static args = {
    dir: Args.string({
      description: bilingual({
        zh: 'gold dataset 目录,必填',
        en: 'Gold dataset dir (required)',
      }),
      required: false,
    }),
  };

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      options: ['zh', 'en'],
      default: 'zh',
      env: 'OMK_LANG',
    }),
  };

  async run(): Promise<void> {
    await this.parse(EvalGoldValidate);
    const rest = process.argv.slice(5);
    const lang = resolveLang(process.argv);
    const { executeValidate } = await import('../../../../commands/eval-gold.js');
    const { CliExit } = await import('../../../../cli-exit.js');
    try {
      await executeValidate(rest, lang);
    } catch (err) {
      if (err instanceof CliExit) {
        if (err.code === 0) return;
        this.exit(err.code);
      }
      throw err;
    }
  }
}
