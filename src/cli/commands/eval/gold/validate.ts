import { Args } from '@oclif/core';
import { BaseCommand } from '../../../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../../../oclif/i18n.js';
import { CliExit } from '../../../lib/cli-exit.js';

export default class EvalGoldValidate extends BaseCommand {
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
    lang: LANG_FLAG,
  };

  async run(): Promise<void> {
    const { args } = await this.parse(EvalGoldValidate);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      const dir = args.dir;
      if (!dir) {
        console.error('Usage: omk eval gold validate <dir>');
        throw new CliExit(1);
      }
      const { validateGoldDataset } = await import('../../../../eval-workflows/grading/gold-cli.js');
      const result = validateGoldDataset(dir);
      if (result.ok) {
        console.log(lang === 'zh'
          ? `✓ gold dataset OK，共 ${result.sampleCount} 条标注`
          : `✓ gold dataset OK — ${result.sampleCount} annotations`);
        return;
      }
      console.error(`✗ gold dataset has ${result.issues.length} issue(s):`);
      for (const msg of result.issues) console.error(`  - ${msg}`);
      throw new CliExit(1);
    });
  }
}
