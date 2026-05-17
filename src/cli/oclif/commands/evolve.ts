import { Args, Command, Flags } from '@oclif/core';
import { bilingual } from '../i18n.js';

// oclif 版 evolve — 透传 argv 给生产 execute()。
// flag schema 镜像 src/cli/commands/evolve.ts 的 RUN_OPTIONS 共 13 个。

export default class Evolve extends Command {
  static description = bilingual({
    zh: '自动迭代改进 skill:多轮 eval + skill 重写，直到达到 --target 或耗尽 --rounds。',
    en: 'Auto-iterate skill improvement: multi-round eval + rewrite until --target or --rounds exhausted.',
  });

  static examples = [
    {
      description: bilingual({
        zh: '默认 5 轮迭代',
        en: 'Default 5 rounds',
      }),
      command: '<%= config.bin %> evolve skills/my-skill/SKILL.md',
    },
    {
      description: bilingual({
        zh: '指定目标分 + 自定义模型',
        en: 'Target score + custom model',
      }),
      command: '<%= config.bin %> evolve skills/my-skill/SKILL.md --target 4.5 --model opus --improve-model opus',
    },
  ];

  static args = {
    skillPath: Args.string({
      description: bilingual({
        zh: 'skill 文件或 SKILL.md 路径。',
        en: 'Skill file or SKILL.md path.',
      }),
      required: true,
    }),
  };

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      default: 'zh',
    }),
    rounds: Flags.string({
      description: bilingual({ zh: '最大迭代轮数，默认 5', en: 'Max iteration rounds, default 5' }),
      default: '5',
    }),
    target: Flags.string({
      description: bilingual({
        zh: '目标 composite 分数，达到即停。不传则跑满 rounds',
        en: 'Target composite score; stop when reached. If omitted, runs all rounds.',
      }),
    }),
    samples: Flags.string({
      description: bilingual({
        zh: '样本文件路径，默认 eval-samples.json',
        en: 'Samples file, default eval-samples.json',
      }),
      default: 'eval-samples.json',
    }),
    model: Flags.string({
      description: bilingual({
        zh: '被评测的 LLM，默认 sonnet',
        en: 'Evaluated LLM, default sonnet',
      }),
      default: 'sonnet',
    }),
    'judge-models': Flags.string({
      description: bilingual({
        zh: '评委 model（单评委约束），格式 executor:model。默认 claude:haiku',
        en: 'Judge model (single judge required), executor:model format. Default claude:haiku',
      }),
      default: 'claude:haiku',
    }),
    'improve-model': Flags.string({
      description: bilingual({
        zh: '负责重写 skill 的 LLM，默认 sonnet',
        en: 'LLM that rewrites the skill, default sonnet',
      }),
      default: 'sonnet',
    }),
    concurrency: Flags.string({
      description: bilingual({ zh: '评测并发数，默认 1', en: 'Eval concurrency, default 1' }),
      default: '1',
    }),
    timeout: Flags.string({
      description: bilingual({ zh: '单样本超时秒，默认 120', en: 'Per-sample timeout sec, default 120' }),
      default: '120',
    }),
    executor: Flags.string({
      description: bilingual({ zh: '执行器名，默认 claude', en: 'Executor name, default claude' }),
      default: 'claude',
    }),
    'skip-connectivity': Flags.boolean({
      description: bilingual({
        zh: '跳过 LLM 连通性预检',
        en: 'Skip LLM connectivity preflight',
      }),
      default: false,
    }),
    effort: Flags.string({
      description: bilingual({
        zh: 'reasoning effort: low/medium/high/xhigh/max',
        en: 'Reasoning effort: low/medium/high/xhigh/max',
      }),
    }),
    'no-diagnostic': Flags.boolean({
      description: bilingual({
        zh: '关 LLM diagnostic 调用',
        en: 'Disable diagnostic LLM call',
      }),
      default: false,
    }),
    'skip-doctor': Flags.boolean({
      description: bilingual({
        zh: '跳过 doctor 门禁（escape hatch，自负 garbage-in 风险）',
        en: 'Skip doctor gate (escape hatch; user takes garbage-in risk)',
      }),
      default: false,
    }),
  };

  async run(): Promise<void> {
    await this.parse(Evolve);
    const argv = this.argv;
    const { execute } = await import('../../commands/evolve.js');
    const { CliExit } = await import('../../cli-exit.js');
    try {
      await execute(argv);
    } catch (err) {
      if (err instanceof CliExit) {
        if (err.code === 0) return;
        this.exit(err.code);
      }
      throw err;
    }
  }
}
