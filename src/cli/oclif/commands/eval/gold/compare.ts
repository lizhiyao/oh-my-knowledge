// oclif 版 eval gold compare — 透传 argv 给生产 executeCompare()。

import { Args, Command, Flags } from '@oclif/core';
import { bilingual, resolveLang } from '../../../i18n.js';

export default class EvalGoldCompare extends Command {
  static description = bilingual({
    zh: '把一份 evaluation report 跟 gold dataset 对比，计算 bootstrap CI 后的 agreement。',
    en: 'Compare an evaluation report against gold dataset, output bootstrap-CI agreement.',
  });

  static args = {
    reportId: Args.string({
      description: bilingual({ zh: 'report ID。', en: 'Report ID.' }),
      required: true,
    }),
  };

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      options: ['zh', 'en'],
      default: 'zh',
    }),
    'gold-dir': Flags.string({
      description: bilingual({ zh: 'gold dataset 目录，必填', en: 'Gold dataset dir (required)' }),
    }),
    variant: Flags.string({
      description: bilingual({
        zh: '只比对指定 variant，默认全比',
        en: 'Compare only specified variant',
      }),
    }),
    'reports-dir': Flags.string({
      description: bilingual({
        zh: '报告目录，默认 ~/.oh-my-knowledge/reports',
        en: 'Reports dir, default ~/.oh-my-knowledge/reports',
      }),
    }),
    'bootstrap-samples': Flags.string({
      description: bilingual({
        zh: 'bootstrap 重采样次数，默认 1000',
        en: 'Bootstrap resamples, default 1000',
      }),
    }),
    seed: Flags.string({
      description: bilingual({ zh: 'bootstrap seed，可复现', en: 'Bootstrap seed for reproducibility' }),
    }),
  };

  async run(): Promise<void> {
    await this.parse(EvalGoldCompare);
    const rest = this.argv;
    const lang = resolveLang(process.argv);
    const { executeCompare } = await import('../../../../commands/eval-gold.js');
    const { CliExit } = await import('../../../../cli-exit.js');
    try {
      await executeCompare(rest, lang);
    } catch (err) {
      if (err instanceof CliExit) {
        if (err.code === 0) return;
        this.exit(err.code);
      }
      throw err;
    }
  }
}
