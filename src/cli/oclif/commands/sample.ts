import { Args, Command, Flags } from '@oclif/core';
import { bilingual } from '../i18n.js';

// oclif 版 sample — 跟 src/cli/commands/sample.ts 行为对得齐。
// 实现策略:flag schema 在这里声明一份(给 oclif --help / strict 校验用),
// run() 实际把 argv 透传给生产 execute(),不重写 batch / fix / single 三路
// 业务分支(避免 470 行重写,降低 PR-B 风险)。
//
// 行为对照表:
// - 缺 positional + 非 batch / fix → exit 1 (生产逻辑)
// - 未知 flag → exit 2 (oclif strict 默认)
// - 已存在 samples / skill 路径不存在 → exit 1 (生产逻辑)
// - batch / fix 路径 → 生产 execute() 全权处理

export default class Sample extends Command {
  static description = bilingual({
    zh: '为指定 skill 生成评测用例(eval-samples)，支持 batch / single / fix 三种模式。',
    en: 'Generate eval samples for the given skill. Supports batch / single / fix modes.',
  });

  static examples = [
    {
      description: bilingual({
        zh: '为单个 skill 生成默认数量的样本',
        en: 'Generate default-count samples for a single skill',
      }),
      command: '<%= config.bin %> sample skills/my-skill/SKILL.md',
    },
    {
      description: bilingual({
        zh: '批量为 skill 目录下所有缺 samples 的 skill 生成',
        en: 'Batch-generate samples for all skills missing them',
      }),
      command: '<%= config.bin %> sample --batch --skill-dir skills',
    },
    {
      description: bilingual({
        zh: '根据最近评测报告自动修复 sample_design 类型失败',
        en: 'Auto-fix sample_design failures using the most recent eval report',
      }),
      command: '<%= config.bin %> sample skills/my-skill/SKILL.md --fix',
    },
  ];

  static args = {
    skillPath: Args.string({
      description: bilingual({
        zh: 'skill 文件路径或 SKILL.md 路径。batch 模式不需要；single / fix 模式必填。',
        en: 'Skill file or SKILL.md path. Not required in batch mode; required for single / fix.',
      }),
      required: false,
    }),
  };

  static flags = {
    lang: Flags.string({
      description: bilingual({
        zh: '输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。',
        en: 'Output language zh|en. Priority: CLI > OMK_LANG env > zh.',
      }),
      options: ['zh', 'en'],
      default: 'zh',
      env: 'OMK_LANG',
    }),
    batch: Flags.boolean({
      description: bilingual({
        zh: '批量模式：扫 --skill-dir 下所有缺 samples 的 skill，逐个生成。',
        en: 'Batch mode: scan --skill-dir, generate samples for any skill missing them.',
      }),
      default: false,
    }),
    count: Flags.string({
      description: bilingual({
        zh: '生成样本条数。不传由 LLM 按 skill 类型自动决定。',
        en: 'Number of samples to generate. Defaults to LLM auto-selection by skill type.',
      }),
    }),
    model: Flags.string({
      description: bilingual({
        zh: '生成 LLM model 名，默认 opus。',
        en: 'Generation LLM model name, default opus.',
      }),
      default: 'opus',
    }),
    'skill-dir': Flags.string({
      description: bilingual({
        zh: 'skill 根目录，默认 skills。batch 模式扫此目录。',
        en: 'Skill root dir, default skills. Used by batch mode.',
      }),
      default: 'skills',
    }),
    focus: Flags.string({
      description: bilingual({
        zh: '生成焦点(自然语言提示)。控制 LLM 偏向哪类用例。',
        en: 'Generation focus (NL hint). Steers LLM toward certain sample types.',
      }),
    }),
    fix: Flags.boolean({
      description: bilingual({
        zh: 'fix 模式：基于最近评测报告自动修复 sample_design 类型失败。',
        en: 'Fix mode: auto-fix sample_design failures using the latest eval report.',
      }),
      default: false,
    }),
    'reports-dir': Flags.string({
      description: bilingual({
        zh: '报告目录(fix 模式用)，默认 ~/.oh-my-knowledge/reports。',
        en: 'Reports dir (fix mode), default ~/.oh-my-knowledge/reports.',
      }),
    }),
    treatment: Flags.string({
      description: bilingual({
        zh: '指定 treatment 名(fix 模式用)，默认推断自 skill 路径。',
        en: 'Treatment name (fix mode), defaults to skill-path inference.',
      }),
    }),
  };

  async run(): Promise<void> {
    // 解析触发 oclif 的 --help / strict 校验。flag 值不直接用,交给生产 execute() 重新 parse argv。
    await this.parse(Sample);

    // 把 argv 透传给生产 execute()。process.argv = [node, script, 'sample', ...args]
    // 生产 execute(argv) 期望 args(切掉前 3 项)。
    const argv = process.argv.slice(3);

    const { execute } = await import('../../commands/sample.js');
    const { CliExit } = await import('../../cli-exit.js');

    try {
      await execute(argv);
    } catch (err) {
      // 生产 execute 走 throw CliExit(code) 表示 exit。oclif 路径下转成 this.exit。
      if (err instanceof CliExit) {
        if (err.code === 0) return;
        this.exit(err.code);
      }
      throw err;
    }
  }
}
