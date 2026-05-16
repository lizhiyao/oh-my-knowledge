import { Command, Flags } from '@oclif/core';
import { bilingual } from '../i18n.js';

// oclif 版 eval(默认 = run 模式) — 透传 argv 给生产 eval-runner execute()。
// flag schema 镜像 RUN_OPTIONS(27) + eval-runner extraOptions(14) = 41 flag。
// 描述简洁,真实语义跟约束在生产 parseRunConfig / eval-runner 里。
//
// `omk eval gold ...` 由 src/cli/oclif/commands/eval/gold/{init,validate,compare}.ts 处理,
// oclif 文件目录路由自动接管,不进 eval.ts。

export default class Eval extends Command {
  static description = bilingual({
    zh: '跑评测：对一个 control vs 多个 treatment skill 做对照试验，产 verdict 报告。',
    en: 'Run evaluation: control vs treatment(s) comparison, produce verdict report.',
  });

  static examples = [
    {
      description: bilingual({
        zh: '最简对照:baseline vs my-skill',
        en: 'Minimal A/B: baseline vs my-skill',
      }),
      command: '<%= config.bin %> eval --control baseline --treatment my-skill',
    },
    {
      description: bilingual({
        zh: 'eval.yaml 驱动 + bootstrap CI',
        en: 'eval.yaml driven + bootstrap CI',
      }),
      command: '<%= config.bin %> eval --config eval.yaml --bootstrap',
    },
  ];

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      options: ['zh', 'en'],
      default: 'zh',
      env: 'OMK_LANG',
    }),
    // ── 实验角色 ──
    control: Flags.string({
      description: bilingual({ zh: 'control variant 表达式', en: 'Control variant expr' }),
    }),
    treatment: Flags.string({
      description: bilingual({
        zh: 'treatment variant 列表，逗号分隔',
        en: 'Treatment variants, comma-separated',
      }),
    }),
    config: Flags.string({
      description: bilingual({ zh: 'eval.yaml 路径', en: 'eval.yaml path' }),
    }),
    samples: Flags.string({
      description: bilingual({
        zh: '样本文件路径。默认 eval-samples.json，也接受 .yaml/.yml；自动发现 --skill-dir 下的 <skill>/.omk/samples.json。',
        en: 'Samples file path. Defaults to eval-samples.json (also .yaml/.yml); auto-discovers <skill>/.omk/samples.json under --skill-dir.',
      }),
    }),
    'skill-dir': Flags.string({
      description: bilingual({ zh: 'skill 目录，默认 skills', en: 'Skill dir, default skills' }),
    }),
    // ── 模型 / 执行器 ──
    model: Flags.string({
      description: bilingual({ zh: '被测模型', en: 'Evaluated model' }),
    }),
    executor: Flags.string({
      description: bilingual({
        zh: '执行器:claude / claude-sdk / codex / codex-sdk / openai-api / gemini / 自定义命令（默认 claude）。',
        en: 'Executor: claude / claude-sdk / codex / codex-sdk / openai-api / gemini / custom (default claude).',
      }),
    }),
    'judge-models': Flags.string({
      description: bilingual({
        zh: '评委配置，格式 executor:model[,...]，例 claude:haiku 或 claude:opus,openai:gpt-4o(≥ 2 个 = ensemble）。默认 <executor>:haiku。',
        en: 'Judge config: executor:model[,...]. e.g. claude:haiku or claude:opus,openai:gpt-4o (≥ 2 = ensemble). Default <executor>:haiku.',
      }),
    }),
    'output-dir': Flags.string({
      description: bilingual({ zh: '报告输出目录', en: 'Report output dir' }),
    }),
    // ── 评测 toggle ──
    'no-judge': Flags.boolean({
      description: bilingual({ zh: '跳过 LLM judge', en: 'Skip LLM judge' }),
    }),
    'no-cache': Flags.boolean({
      description: bilingual({ zh: '跳过 executor cache', en: 'Skip executor cache' }),
    }),
    'dry-run': Flags.boolean({
      description: bilingual({ zh: '只 plan 不实跑', en: 'Plan only, no real exec' }),
    }),
    concurrency: Flags.string({
      description: bilingual({ zh: '并发数，默认 1', en: 'Concurrency, default 1' }),
    }),
    timeout: Flags.string({
      description: bilingual({ zh: '单样本超时秒，默认 120', en: 'Per-sample timeout sec, default 120' }),
    }),
    batch: Flags.boolean({
      description: bilingual({
        zh: 'batch 模式:baseline vs 每个 skill',
        en: 'Batch mode: baseline vs each skill',
      }),
    }),
    'skip-connectivity': Flags.boolean({
      description: bilingual({ zh: '跳 LLM 连通性预检', en: 'Skip LLM connectivity preflight' }),
    }),
    'skip-doctor': Flags.boolean({
      description: bilingual({
        zh: 'escape hatch:跳 doctor 健康检查门禁（默认强制启用）。沙箱 mock 提供依赖时绕开 doctor 物理路径误报；garbage-in 风险自负。',
        en: 'Escape hatch: skip the doctor health-check gate (on by default). Use when sandbox mocks supply deps; caller owns garbage-in risk.',
      }),
    }),
    'mcp-config': Flags.string({
      description: bilingual({ zh: 'MCP 配置文件路径', en: 'MCP config path' }),
    }),
    'no-serve': Flags.boolean({
      description: bilingual({ zh: '不启 report server', en: 'Do not start report server' }),
    }),
    verbose: Flags.boolean({
      description: bilingual({ zh: '详细日志', en: 'Verbose logging' }),
    }),
    retry: Flags.string({
      description: bilingual({ zh: '失败 sample 重试次数', en: 'Per-sample retry count' }),
    }),
    resume: Flags.string({
      description: bilingual({ zh: '从某次失败 run 续跑', en: 'Resume a previous failed run' }),
    }),
    'layered-stats': Flags.boolean({
      description: bilingual({ zh: '输出分层统计', en: 'Emit layered stats' }),
    }),
    'strict-baseline': Flags.boolean({
      description: bilingual({ zh: '强制 baseline 隔离（default true）', en: 'Force baseline isolation (default true)' }),
    }),
    'no-strict-baseline': Flags.boolean({
      description: bilingual({ zh: '关闭 baseline 隔离', en: 'Disable baseline isolation' }),
    }),
    effort: Flags.string({
      description: bilingual({
        zh: '被测 LLM 扩展思考预算 low/medium/high/xhigh/max（默认 low；跨 effort 报告不严格可比）。',
        en: 'Executor LLM reasoning effort low/medium/high/xhigh/max (default low; reports across efforts not strictly comparable).',
      }),
    }),
    'no-diagnostic': Flags.boolean({
      description: bilingual({
        zh: '关闭 diagnostic 诊断 LLM 调用（默认开，给 failed sample 出「哪错了 + 怎么改」建议）。',
        en: 'Disable diagnostic LLM call (on by default; emits "what went wrong + how to fix" advice for failed samples).',
      }),
    }),
    // ── eval-runner extra ──
    blind: Flags.boolean({
      description: bilingual({ zh: 'judge blind 模式', en: 'Blind judge mode' }),
    }),
    repeat: Flags.string({
      description: bilingual({ zh: '每个 sample 重复跑 N 次', en: 'Repeat each sample N times' }),
    }),
    'judge-repeat': Flags.string({
      description: bilingual({ zh: '每个 dim 评 N 次', en: 'Judge each dim N times' }),
    }),
    bootstrap: Flags.boolean({
      description: bilingual({ zh: '加 bootstrap CI', en: 'Add bootstrap CI' }),
    }),
    'bootstrap-samples': Flags.string({
      description: bilingual({ zh: 'bootstrap 重采样次数，默认 1000', en: 'Bootstrap resamples, default 1000' }),
    }),
    'gold-dir': Flags.string({
      description: bilingual({ zh: 'gold dataset 目录', en: 'Gold dataset dir' }),
    }),
    'no-debias-length': Flags.boolean({
      description: bilingual({ zh: '关 length-debias（默认开）', en: 'Disable length-debias (default on)' }),
    }),
    'budget-usd': Flags.string({
      description: bilingual({ zh: '总预算上限 USD', en: 'Total budget cap USD' }),
    }),
    'budget-per-sample-usd': Flags.string({
      description: bilingual({ zh: '单 sample 预算上限 USD', en: 'Per-sample budget cap USD' }),
    }),
    'budget-per-sample-ms': Flags.string({
      description: bilingual({ zh: '单 sample 时长上限 ms', en: 'Per-sample time cap ms' }),
    }),
    threshold: Flags.string({
      description: bilingual({ zh: 'verdict 阈值，默认 3.5', en: 'Verdict threshold, default 3.5' }),
    }),
    'trivial-diff': Flags.string({
      description: bilingual({ zh: '可忽略 diff 容差', en: 'Trivial diff tolerance' }),
    }),
    'report-only': Flags.boolean({
      description: bilingual({
        zh: '生成报告并打印 verdict，但始终 exit 0(不参与 CI gate）。',
        en: 'Produce the report and print verdict, but always exit 0 (no CI gate).',
      }),
    }),
    'no-gate': Flags.boolean({
      description: bilingual({ zh: '关 verdict gate', en: 'Disable verdict gate' }),
    }),
  };

  async run(): Promise<void> {
    await this.parse(Eval);
    // 透传给生产 eval-runner.execute()(直接进 run 模式,不经 eval.ts 的 sub 路由)。
    // 用 this.argv 而不是 process.argv.slice(N):oclif 已经把命令路径切掉,space-syntax
    // (omk eval ...)跟 colon-syntax(omk eval:...)输出一致,避免 N 写死导致 colon 路径
    // 静默丢 flag。
    const argv = this.argv;
    const { execute } = await import('../../commands/eval-runner.js');
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
