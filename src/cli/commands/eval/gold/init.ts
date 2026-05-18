import { Command, Flags } from '@oclif/core';
import { bilingual, resolveLang } from '../../../oclif/i18n.js';
import { CliExit } from '../../../lib/cli-exit.js';

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
    const { flags } = await this.parse(EvalGoldInit);
    const lang = resolveLang(process.argv);
    try {
      const { initGoldDataset } = await import('../../../../grading/gold-cli.js');
      try {
        const written = initGoldDataset(flags.out, {
          annotator: flags.annotator,
        });
        console.log(lang === 'zh'
          ? `已在 ${flags.out} 创建 ${written.length} 个文件：`
          : `Created ${written.length} files in ${flags.out}:`);
        for (const p of written) console.log(`  ${p}`);
        console.log(lang === 'zh'
          ? '\n下一步：编辑 annotations.yaml 加入真实标注，然后运行 omk eval gold validate'
          : '\nNext step: edit annotations.yaml with real annotations, then run omk eval gold validate');
      } catch (err) {
        console.error((err as Error).message);
        throw new CliExit(1);
      }
    } catch (err) {
      if (err instanceof CliExit) {
        if (err.code === 0) return;
        this.exit(err.code);
        return;
      }
      throw err;
    }
  }
}
