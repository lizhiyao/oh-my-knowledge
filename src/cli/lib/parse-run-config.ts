/**
 * oclif typed flags → `RunConfig` 装配。
 *
 * 主体 `parseRunConfig` 是「CLI > eval.yaml > 硬编码 default」精度链的统一落点 ——
 * 把 oclif strict 模式接受过的 flag values + 可选 eval.yaml 合并成 eval 子命令运行
 * 所需的完整 `RunConfig`,后续 `executeEvaluationPipeline` 与 doctor / batch 都从这
 * 里读字段。
 *
 * 3 个 sub-routine 拆到同级 parse-run-config/ 目录,主文件保留它们的 re-export
 * 让外部 import surface(`parseJudgeModelsArg` / `parseJudgeModelsArgOrExit`)
 * 不动:
 *   - judge-models.ts: --judge-models 字符串解析
 *   - samples-discovery.ts: 未传 --samples 时的路径发现
 *   - variant-resolution.ts: --control / --treatment / eval.yaml.variants 三态合并
 *
 * 主体 parseRunConfig 自身保留约 100 行的 field-default fanout —— 每个字段一行
 * `cli ?? evalConfig ?? default`,刻意不再细拆,否则只是把一长串 ?? 散到多文件,
 * 反而失去「精度链一目了然」的可读性。
 */

import { resolve } from 'node:path';
import { projectReportsDir, globalReportsDir } from '../../eval-core/measurement-dirs.js';
import { loadEvalConfig } from '../../inputs/eval-config.js';
import { DEFAULT_MODEL } from '../../executors/shared.js';
import type {
  EvalConfig,
  VariantSpec,
  JudgeConfig,
  EvalBudget,
  ProgressCallback,
} from '../../types/index.js';
import { parseJudgeModelsArgOrExit } from './parse-run-config/judge-models.js';
import { discoverSamplesPath } from './parse-run-config/samples-discovery.js';
import { resolveVariantSpecs } from './parse-run-config/variant-resolution.js';

export { parseJudgeModelsArg, parseJudgeModelsArgOrExit } from './parse-run-config/judge-models.js';

export interface RunConfig {
  samplesPath: string;
  skillDir: string;
  variantSpecs: VariantSpec[];
  model: string | undefined;
  outputDir: string;
  noJudge: boolean | undefined;
  noCache: boolean | undefined;
  dryRun: boolean | undefined;
  concurrency: number;
  timeoutMs: number;
  executorName: string | undefined;
  /** 跳过 LLM 模型连通性检测。--resume 时自动 true(已经验过)。 */
  skipConnectivity: boolean | undefined;
  /** 跳过 doctor 健康检查门禁(--skip-doctor)。escape hatch — 默认 false。
   *  开启后 doctor 整段不跑(节省静态检查时间);doctor 失败也不再阻断 eval。
   *  典型场景:依赖在评测环境中通过 mock / stub 提供,doctor 的物理路径检查
   *  会误报。开启意味着用户接受 garbage-in 风险,自己负责依赖正确性。 */
  skipDoctor: boolean | undefined;
  /** 用户语言, 透传给 doctor 报告渲染。 */
  lang: 'zh' | 'en' | undefined;
  mcpConfig: string | undefined;
  verbose: boolean | undefined;
  retry?: number;
  resume?: string;
  layeredStats?: boolean;
  /** --holdout-ratio R (0 < R < 1). Hold out a deterministic sample slice; report-finalize
   *  computes train vs holdout composite (report.analysis.holdout) for the overfitting gate. */
  holdoutRatio?: number;
  /** --judge-repeat N. Calls LLM judge N times per (sample × dimension). Default 1. */
  judgeRepeat?: number;
  /** Unified judge config. Always non-empty; 1 entry = single judge, ≥ 2 = ensemble.
   *  parseRunConfig guarantees at least `[{executor: <executor>, model: 'haiku'}]`. */
  judgeModels: JudgeConfig[];
  /** --bootstrap. Adds bootstrap CI to summary (per-variant mean + pairwise diff). */
  bootstrap?: boolean;
  /** --bootstrap-samples N. Bootstrap resamples count, default 1000. */
  bootstrapSamples?: number;
  /** length-debias toggle. Default true; --no-debias-length sets false. */
  lengthDebias?: boolean;
  /** hard budget caps from CLI or config. */
  budget?: EvalBudget;
  /** Skill isolation default for baseline-kind variants. Default true.
   *  CLI flag --no-strict-baseline disables strict isolation. */
  strictBaseline?: boolean;
  /** Per-variant allowedSkills override extracted from eval.yaml. Always wins
   *  over strictBaseline default. Keyed by variant name. */
  variantAllowedSkills?: Record<string, string[]>;
  /** Reasoning effort for the executor LLM(被评测的模型,不是 judge)。
   *  Default 'low' — sonnet 默认会做大量扩展思考(13K thinking tokens / 单次),
   *  对结构化任务是浪费。低 effort 大幅省时间/成本但可能损失复杂推理质量,
   *  跨 effort 的报告不能严格比较。`undefined` 走 claude CLI / SDK 自身默认。 */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 关闭 diagnostic LLM call。Default false(总是给 failed sample 跑诊断)。
   *  跟 noJudge 完全独立 — judge 答打分,diagnostic 答怎么改。 */
  noDiagnostic?: boolean;
  onProgress?: ProgressCallback | null;
}

export interface ParseRunConfigResult {
  values: Record<string, string | boolean | undefined>;
  config: RunConfig;
  /** Loaded eval.yaml when --config was provided. `commands/eval-runner.ts` uses it to apply
   *  CLI > eval.yaml > default fallback for fields not propagated by parseRunConfig
   *  (e.g. repeat / judgeRepeat / bootstrap — handled in `commands/eval-runner.ts` for input validation). */
  evalConfig: EvalConfig | null;
}

/**
 * 接 typed flags(来自 oclif Command.parse() 输出)。oclif strict 模式已经在
 * 上游对未知 flag 拦截 exit 2,这里不再 parseArgs。eval-runner 等业务 caller
 * 把 oclif flags 当 values 喂进来。
 */
export function parseRunConfig(
  values: Record<string, unknown>,
): ParseRunConfigResult {
  if (values.variants !== undefined) {
    throw new Error(
      `--variants 已在 v0.16 废除，请改用 --control <expr> 与 --treatment <v1,v2,...>\n`
      + `  迁移示例：--variants baseline,my-skill  →  --control baseline --treatment my-skill\n`
      + `  复杂场景可用 --config eval.yaml（参见 docs/zh/specs/terminology-spec.md）`,
    );
  }
  // 1) Load --config (if provided). All subsequent fields fall back to it when CLI is silent.
  const evalConfig: EvalConfig | null = values.config
    ? loadEvalConfig(values.config as string)
    : null;

  const skillDir: string = resolve((values['skill-dir'] as string | undefined) ?? 'skills');

  // 2) Resolve samples path: CLI > config > single-treatment skill-local discovery > cwd project default.
  // Skill-local discovery only fires when exactly one --treatment is given, so omk knows
  // which skill's bundled samples to use. The `<skill>/.omk/` dir form (loadSamples handles
  // both file + dir) means a skill can split samples across multiple files.
  const cliSamples = values.samples as string | undefined;
  let samplesFile: string;
  if (cliSamples) {
    samplesFile = cliSamples;
  } else if (evalConfig?.samples) {
    samplesFile = evalConfig.samples;  // already resolved against config file dir
  } else {
    samplesFile = discoverSamplesPath(values, skillDir);
  }

  // 3) Resolve variantSpecs: CLI > config > batch > error。dedup 在 helper 里。
  const variantSpecs = resolveVariantSpecs(values, evalConfig, skillDir);

  // 4) Apply CLI > config > hard-coded default for all other fields.
  const executorName = (values.executor as string | undefined) ?? evalConfig?.executor ?? 'claude';
  // model fallback 链:CLI > eval.yaml > DEFAULT_MODEL(opus 4.7)。
  // 改 default 时同步 src/cli/commands/eval.ts 里 --model flag description 的默认值文案。
  const model = (values.model as string | undefined) ?? evalConfig?.model ?? DEFAULT_MODEL;

  // judgeModels: unified judge config. Parse --judge-models (CLI) or evalConfig.judgeModels (yaml).
  // 1 entry = single judge, ≥ 2 entries = ensemble. Format `executor:model[,executor:model]`.
  // 出口 RunConfig.judgeModels 保证非空 (default `[{executor, model: 'haiku'}]`)。
  const cliJudgesRaw = values['judge-models'] as string | undefined;
  const parsedJudges = cliJudgesRaw !== undefined ? parseJudgeModelsArgOrExit(cliJudgesRaw) : undefined;
  const judgeModels: JudgeConfig[] = parsedJudges
    ?? evalConfig?.judgeModels
    ?? [{ executor: executorName, model: 'haiku' }];
  // 报告默认落项目 `.omk/reports`(绑用例集,construct validity);--global 写全局;--output-dir 最高优先。
  // 同 observe / doctor 写入侧口径。读取侧(studio / resume / gold-compare / 复用)走 overlay 项目→全局兜底。
  const outputDir = resolve(
    (values['output-dir'] as string | undefined)
    ?? (values.global ? globalReportsDir() : projectReportsDir()),
  );
  const concurrencyRaw =
    (values.concurrency as string | undefined) !== undefined
      ? Number(values.concurrency)
      : evalConfig?.concurrency ?? 1;
  const concurrency = Math.max(1, Number(concurrencyRaw) || 1);
  const timeoutSec =
    (values.timeout as string | undefined) !== undefined
      ? Number(values.timeout)
      : evalConfig?.timeoutMs
        ? evalConfig.timeoutMs / 1000
        : 120;
  const timeoutMs = Math.max(1, Number(timeoutSec) || 120) * 1000;
  const noJudge = (values['no-judge'] as boolean | undefined) ?? evalConfig?.noJudge ?? false;
  const noCache = (values['no-cache'] as boolean | undefined) ?? evalConfig?.noCache ?? false;
  const dryRun = (values['dry-run'] as boolean | undefined) ?? false;
  const skipConnectivity = (values['skip-connectivity'] as boolean | undefined) ?? false;
  const skipDoctor = (values['skip-doctor'] as boolean | undefined) ?? evalConfig?.skipDoctor ?? false;
  const mcpConfig = (values['mcp-config'] as string | undefined) ?? evalConfig?.mcpConfig;
  const verbose = (values.verbose as boolean | undefined) ?? false;
  const retry = Math.max(0, Number(values.retry ?? 0) || 0);
  const resume = values.resume as string | undefined;
  const layeredStats = (values['layered-stats'] as boolean | undefined) ?? false;

  // strict-baseline default true. Reconcile both flag forms with eval.yaml fallback.
  // Priority: --no-strict-baseline > --strict-baseline > eval.yaml strictBaseline > true。
  const noStrictFlag = values['no-strict-baseline'] as boolean | undefined;
  const strictFlag = values['strict-baseline'] as boolean | undefined;
  const strictBaseline: boolean = noStrictFlag === true
    ? false
    : strictFlag === true
      ? true
      : (evalConfig?.strictBaseline ?? true);

  // extract eval.yaml variant.allowedSkills overrides (per-variant). Always
  // wins over strictBaseline default. Empty object when no eval.yaml or no overrides.
  const variantAllowedSkills: Record<string, string[]> = {};
  if (evalConfig?.variants) {
    for (const v of evalConfig.variants) {
      if (v.allowedSkills !== undefined) {
        variantAllowedSkills[v.name] = v.allowedSkills;
      }
    }
  }

  // effort:CLI > evalConfig > 默认 'low'。校验合法值,不合法就 throw(early surface error)。
  const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
  const effortRaw = (values.effort as string | undefined) ?? evalConfig?.effort ?? 'low';
  if (!VALID_EFFORTS.has(effortRaw)) {
    throw new Error(`--effort must be one of low/medium/high/xhigh/max (got "${effortRaw}")`);
  }
  const effort = effortRaw as 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  const noDiagnostic = (values['no-diagnostic'] as boolean | undefined) ?? evalConfig?.noDiagnostic ?? false;

  return {
    values: values as Record<string, string | boolean | undefined>,
    config: {
      samplesPath: resolve(samplesFile),
      skillDir,
      variantSpecs,
      model,
      outputDir,
      noJudge,
      noCache,
      dryRun,
      concurrency,
      timeoutMs,
      executorName,
      skipConnectivity,
      skipDoctor,
      lang: undefined, // CLI 入口在 commands/eval-runner.ts 里注入
      mcpConfig,
      verbose,
      retry,
      resume,
      layeredStats,
      budget: evalConfig?.budget,
      strictBaseline,
      judgeModels,
      effort,
      noDiagnostic,
      ...(Object.keys(variantAllowedSkills).length > 0 && { variantAllowedSkills }),
    },
    evalConfig,
  };
}
