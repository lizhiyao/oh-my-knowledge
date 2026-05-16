import { Command, Flags } from '@oclif/core';
import { bilingual, t } from '../../i18n.js';

// spike 版 studio dump — 二级 subcommand,验证 enum flag + 多 subcommand 元数据 walk。

export default class StudioDump extends Command {
  static description = bilingual({
    zh: '把当前 studio 数据 dump 成 JSON/YAML(给 CI / 外部脚本消费)。',
    en: 'Dump studio data as JSON/YAML (for CI / external scripts).',
  });

  static examples = [
    {
      description: bilingual({
        zh: 'JSON 模式 dump 到 stdout',
        en: 'Dump as JSON to stdout',
      }),
      command: '<%= config.bin %> studio dump --format json',
    },
  ];

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      options: ['zh', 'en'],
      default: 'zh',
      env: 'OMK_LANG',
    }),
    format: Flags.string({
      description: bilingual({
        zh: 'dump 格式 json|yaml',
        en: 'Dump format json|yaml',
      }),
      options: ['json', 'yaml'],
      default: 'json',
    }),
    output: Flags.string({
      description: bilingual({
        zh: '输出文件路径,默认 stdout',
        en: 'Output file path (default stdout)',
      }),
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StudioDump);
    const lang = (flags.lang === 'en' ? 'en' : 'zh') as 'zh' | 'en';
    this.log(
      `[spike studio dump] format=${flags.format} output=${flags.output ?? '(stdout)'}`,
    );
    this.log(
      t(
        {
          zh: `✔ studio dump 完成,格式 ${flags.format}(spike 占位)`,
          en: `✔ studio dump done, format=${flags.format} (spike stub)`,
        },
        lang,
      ),
    );
  }
}
