import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { discoverVariants, parseVariantCwd } from '../inputs/skill-loader.js';
import { CliExit } from './cli-exit.js';
import { loadEvalConfig, configVariantsToSpecs } from '../inputs/eval-config.js';
import { DEFAULT_MODEL } from '../executors/shared.js';
import type {
  EvalConfig,
  VariantSpec,
  JudgeConfig,
  EvalBudget,
  ProgressCallback,
} from '../types/index.js';

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
  blind?: boolean | undefined;
  retry?: number;
  resume?: string;
  layeredStats?: boolean;
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

export const DEFAULT_REPORTS_DIR: string = join(homedir(), '.oh-my-knowledge', 'reports');

/**
 * 解析 `--judge-models` CLI 参数:`executor:model[,executor:model,...]`。
 * - 空字符串 / 全空 entry 抛错(避免 silent default)。
 * - entry 格式 `executor:model`,缺一报错。
 * - 重复 `executor:model` 拒绝(否则 ensemble 聚合用 Map<judgeId, scores> 会把
 *   同 id 合并,N 不可信、agreement 失真;而 grading 阶段又会按 entry 数实际跑 N 次)。
 * - 1 entry = 单评委,≥ 2 = ensemble(由调用方决定是否接受 ensemble)。
 */
export function parseJudgeModelsArg(raw: string): JudgeConfig[] {
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`--judge-models cannot be empty`);
  }
  const result: JudgeConfig[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const idx = p.indexOf(':');
    if (idx <= 0 || idx === p.length - 1) {
      throw new Error(`--judge-models entry must be 'executor:model' (got "${p}")`);
    }
    const executor = p.slice(0, idx);
    const model = p.slice(idx + 1);
    const key = `${executor}:${model}`;
    if (seen.has(key)) {
      throw new Error(`--judge-models has duplicate entry "${key}"; ensemble 聚合按 executor:model 去重,重复条目会让 N 不可信、agreement 失真`);
    }
    seen.add(key);
    result.push({ executor, model });
  }
  return result;
}

/**
 * Friendly CLI wrapper around `parseJudgeModelsArg`. On parse error prints
 * `error: <msg>` to stderr and exits 2 — matching `parseArgsStrict` 对 unknown
 * option 的行为(exit 2 = parser/参数错误,区别于 doctor / gate eval failure 的
 * exit 1）。CLI 层 `eval` / `evolve` 共享这一份。
 */
export function parseJudgeModelsArgOrExit(raw: string): JudgeConfig[] {
  try {
    return parseJudgeModelsArg(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: ${msg}`);
    throw new CliExit(2);
  }
}

/**
 * When --samples isn't given, try to discover from `<skillDir>/<treatment>/.omk/`.
 * `loadSamples` handles dir mode internally — globs `*.{json,yaml,yml}` and merges,
 * skipping reserved prefixes (report-, health-, underscore-). No filename is special:
 * drop a single `samples.json` or split across `workflow.json` + `platform.json` etc.
 * Both work the same.
 *
 * Falls back to legacy cwd defaults (`eval-samples.{json,yaml,yml}`) if `.omk/` isn't
 * present. Multi-treatment evals must pass --samples explicitly.
 */
function discoverSamplesPath(values: Record<string, unknown>, skillDir: string): string {
  const treatmentRaw = values.treatment as string | undefined;
  const treatments = treatmentRaw
    ? treatmentRaw.split(',').map((v) => v.trim()).filter(Boolean)
    : [];
  if (treatments.length === 1) {
    const tname = parseVariantCwd(treatments[0]).name;
    const omkDir = join(skillDir, tname, '.omk');
    if (existsSync(omkDir)) return omkDir;
  }
  // Legacy cwd defaults
  let cwdFile = 'eval-samples.json';
  if (!existsSync(resolve(cwdFile))) {
    if (existsSync(resolve('eval-samples.yaml'))) cwdFile = 'eval-samples.yaml';
    else if (existsSync(resolve('eval-samples.yml'))) cwdFile = 'eval-samples.yml';
  }
  return cwdFile;
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
      + `  复杂场景可用 --config eval.yaml（参见 docs/terminology-spec.md）`,
    );
  }
  // 1) Load --config (if provided). All subsequent fields fall back to it when CLI is silent.
  const evalConfig: EvalConfig | null = values.config
    ? loadEvalConfig(values.config as string)
    : null;

  const skillDir: string = resolve((values['skill-dir'] as string | undefined) ?? 'skills');

  // 2) Resolve samples path: CLI > config > <skillDir>/<treatment>/.omk/ discovery > cwd default.
  // The .omk/ discovery only fires when exactly one --treatment is given, so omk knows
  // which skill's bundled samples to use. The dir form (loadSamples handles both file + dir)
  // means a skill can split samples across multiple files (workflow.json / platform.json / ...).
  const cliSamples = values.samples as string | undefined;
  let samplesFile: string;
  if (cliSamples) {
    samplesFile = cliSamples;
  } else if (evalConfig?.samples) {
    samplesFile = evalConfig.samples;  // already resolved against config file dir
  } else {
    samplesFile = discoverSamplesPath(values, skillDir);
  }

  // 3) Resolve variantSpecs: CLI > config. If neither, error with a helpful hint.
  const controlExpr = values.control as string | undefined;
  const treatmentExprs: string[] = values.treatment
    ? (values.treatment as string).split(',').map((v: string) => v.trim()).filter(Boolean)
    : [];

  let variantSpecs: VariantSpec[];
  if (controlExpr || treatmentExprs.length > 0) {
    // CLI roles present → CLI entirely replaces config.variants (no merging).
    variantSpecs = [];
    if (controlExpr) {
      variantSpecs.push({ name: parseVariantCwd(controlExpr).name, role: 'control', expr: controlExpr });
    }
    for (const expr of treatmentExprs) {
      variantSpecs.push({ name: parseVariantCwd(expr).name, role: 'treatment', expr });
    }
  } else if (evalConfig) {
    variantSpecs = configVariantsToSpecs(evalConfig.variants);
  } else if (values.batch) {
    // --batch 模式自动用 baseline (control) vs 每个 skill (treatment),
    // 不需要用户显式传 --control / --treatment,校验跳过。
    variantSpecs = [];
  } else {
    const discovered = discoverVariants(skillDir);
    const hint = discovered.length > 0 ? `\n  skill-dir (${skillDir}) 下发现的候选：${discovered.join(', ')}` : '';
    throw new Error(
      `请通过 --control / --treatment 或 --config eval.yaml 声明 variant 角色。\n`
      + `  示例：omk eval --control baseline --treatment my-skill${hint}\n`
      + `  --batch 模式下自动用 baseline vs 每个 skill,无需显式声明\n`
      + `  术语见 docs/terminology-spec.md（v0.16 起废除 --variants，改用 experiment role 显式声明）`,
    );
  }

  const seenNames = new Set<string>();
  for (const spec of variantSpecs) {
    if (seenNames.has(spec.name)) {
      throw new Error(
        `variant "${spec.name}" 重复出现——同一 variant 不能同时属于 --control 与 --treatment，也不能在 --treatment 中重复。`,
      );
    }
    seenNames.add(spec.name);
  }

  // 4) Apply CLI > config > hard-coded default for all other fields.
  const executorName = (values.executor as string | undefined) ?? evalConfig?.executor ?? 'claude';
  // model fallback 链:CLI > eval.yaml > DEFAULT_MODEL(opus 4.7)。
  // 改 default 时同步 src/cli/oclif/commands/eval.ts 里 --model flag description 的默认值文案。
  const model = (values.model as string | undefined) ?? evalConfig?.model ?? DEFAULT_MODEL;

  // judgeModels: unified judge config. Parse --judge-models (CLI) or evalConfig.judgeModels (yaml).
  // 1 entry = single judge, ≥ 2 entries = ensemble. Format `executor:model[,executor:model]`.
  // 出口 RunConfig.judgeModels 保证非空 (default `[{executor, model: 'haiku'}]`)。
  const cliJudgesRaw = values['judge-models'] as string | undefined;
  const parsedJudges = cliJudgesRaw !== undefined ? parseJudgeModelsArgOrExit(cliJudgesRaw) : undefined;
  const judgeModels: JudgeConfig[] = parsedJudges
    ?? evalConfig?.judgeModels
    ?? [{ executor: executorName, model: 'haiku' }];
  const outputDir = resolve((values['output-dir'] as string | undefined) ?? DEFAULT_REPORTS_DIR);
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
  const blind = (values.blind as boolean | undefined) ?? evalConfig?.blind ?? false;
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
      blind,
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
