import { Args, Command, Flags } from '@oclif/core';
import { bilingual, resolveLang, t } from '../i18n.js';

// spike 版 sample — 复刻 omk 生产 src/cli/commands/sample.ts 的 positional + flag 形态:
// - positional skillPath(required) → 验证 oclif Args required 行为
// - --count <int> default 5 → 验证 integer flag + default
// - --output <path> → 普通 string flag,可选
// - --strategy <enum> → 验证 enum (options: [...]) 校验
// 关注 6 项验收的第 3 项「--no-* + default + required + positionals」

export default class Sample extends Command {
  static description = bilingual({
    zh: '为指定 skill 生成评测用例(eval-samples)。',
    en: 'Generate eval samples for the given skill.',
  });

  static examples = [
    {
      description: bilingual({
        zh: 'workflow 策略生成 5 条用例',
        en: 'Workflow strategy, 5 samples',
      }),
      command: '<%= config.bin %> sample skills/code-review',
    },
    {
      description: bilingual({
        zh: 'hybrid 策略生成 10 条 + 自定义输出路径',
        en: 'Hybrid strategy, 10 samples, custom output path',
      }),
      command: '<%= config.bin %> sample skills/code-review --strategy hybrid --count 10 --output out.json',
    },
  ];

  static args = {
    skillPath: Args.string({
      description: bilingual({
        zh: 'skill 文件或目录的路径,必填',
        en: 'Path to skill .md or skill dir (required)',
      }),
      required: true,
    }),
  };

  static flags = {
    lang: Flags.string({
      description: bilingual({
        zh: '输出语言 zh|en',
        en: 'Output language zh|en',
      }),
      options: ['zh', 'en'],
      default: 'zh',
      env: 'OMK_LANG',
    }),
    count: Flags.integer({
      description: bilingual({
        zh: '生成多少条样本,默认 5',
        en: 'How many samples to generate (default 5)',
      }),
      default: 5,
    }),
    output: Flags.string({
      description: bilingual({
        zh: '输出 JSON 路径,默认 eval-samples.json',
        en: 'Output JSON path (default eval-samples.json)',
      }),
    }),
    strategy: Flags.string({
      description: bilingual({
        zh: '采样策略 workflow|contrastive|hybrid',
        en: 'Sampling strategy: workflow|contrastive|hybrid',
      }),
      options: ['workflow', 'contrastive', 'hybrid'],
      default: 'workflow',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Sample);
    const lang = (flags.lang === 'en' ? 'en' : 'zh') as 'zh' | 'en';
    const _detected = resolveLang(process.argv);

    this.log(
      `[spike sample] skillPath=${args.skillPath} count=${flags.count} `
      + `strategy=${flags.strategy} output=${flags.output ?? '(default)'}`,
    );

    this.log(
      t(
        {
          zh: `✔ 已为 ${args.skillPath} 生成 ${flags.count} 条 ${flags.strategy} 样本(spike 占位)`,
          en: `✔ Generated ${flags.count} ${flags.strategy} samples for ${args.skillPath} (spike stub)`,
        },
        lang,
      ),
    );
  }
}
