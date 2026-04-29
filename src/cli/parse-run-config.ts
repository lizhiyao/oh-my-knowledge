import { parseArgs, type ParseArgsConfig } from 'node:util';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { discoverVariants, parseVariantCwd } from '../inputs/skill-loader.js';
import { loadEvalConfig, configVariantsToSpecs } from '../inputs/eval-config.js';
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
  judgeModel: string | undefined;
  outputDir: string;
  noJudge: boolean | undefined;
  noCache: boolean | undefined;
  dryRun: boolean | undefined;
  concurrency: number;
  timeoutMs: number;
  executorName: string | undefined;
  judgeExecutorName: string | undefined;
  skipPreflight: boolean | undefined;
  mcpConfig: string | undefined;
  verbose: boolean | undefined;
  blind?: boolean | undefined;
  retry?: number;
  resume?: string;
  layeredStats?: boolean;
  /** --judge-repeat N. Calls LLM judge N times per (sample × dimension). Default 1. */
  judgeRepeat?: number;
  /** --judge-models executor:model,executor:model,... — multi-judge ensemble (≥ 2 entries). */
  judgeModels?: JudgeConfig[];
  /** --bootstrap. Adds bootstrap CI to summary (per-variant mean + pairwise diff). */
  bootstrap?: boolean;
  /** --bootstrap-samples N. Bootstrap resamples count, default 1000. */
  bootstrapSamples?: number;
  /** v0.21 Phase 3a length-debias toggle. Default true; --no-debias-length sets false. */
  lengthDebias?: boolean;
  /** hard budget caps from CLI or config. */
  budget?: EvalBudget;
  /** Skill isolation default for baseline-kind variants. Default true.
   *  CLI flag --no-strict-baseline disables strict isolation. */
  strictBaseline?: boolean;
  /** Per-variant allowedSkills override extracted from eval.yaml. Always wins
   *  over strictBaseline default. Keyed by variant name. */
  variantAllowedSkills?: Record<string, string[]>;
  onProgress?: ProgressCallback | null;
}

export interface ParseRunConfigResult {
  values: Record<string, string | boolean | undefined>;
  config: RunConfig;
}

export const DEFAULT_REPORTS_DIR: string = join(homedir(), '.oh-my-knowledge', 'reports');

/**
 * 所有子命令都接受的通用 flag。新增 --lang 让 parseArgs strict:false 模式下
 * 仍能把值类型化到 values.lang 上(否则未声明的 flag 会被丢弃)。
 */
export const COMMON_OPTIONS: ParseArgsConfig['options'] = {
  lang: { type: 'string' },
};

// Shared CLI options for run/ci commands.
// Defaults are applied inside parseRunConfig (after config-file merge) so that
// CLI `undefined` can be reliably distinguished from "user passed the default value".
// Priority order resolved in parseRunConfig: CLI arg > --config file > hard-coded default.
export const RUN_OPTIONS: ParseArgsConfig['options'] = {
  ...COMMON_OPTIONS,
  samples: { type: 'string' },
  'skill-dir': { type: 'string' },
  control: { type: 'string' },
  treatment: { type: 'string' },
  config: { type: 'string' },
  model: { type: 'string' },
  'judge-model': { type: 'string' },
  'output-dir': { type: 'string' },
  'no-judge': { type: 'boolean' },
  'no-cache': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  concurrency: { type: 'string' },
  timeout: { type: 'string' },
  executor: { type: 'string' },
  'judge-executor': { type: 'string' },
  each: { type: 'boolean' },
  'skip-preflight': { type: 'boolean' },
  'mcp-config': { type: 'string' },
  'no-serve': { type: 'boolean' },
  verbose: { type: 'boolean' },
  retry: { type: 'string' },
  resume: { type: 'string' },
  'layered-stats': { type: 'boolean' },
  // strict-baseline default true. Declare both forms; reconcile in
  // parseRunConfig (后者赢)。strict-baseline 没传 + no-strict-baseline 没传 = default true。
  'strict-baseline': { type: 'boolean' },
  'no-strict-baseline': { type: 'boolean' },
};

export function parseRunConfig(
  argv: string[],
  extraOptions: ParseArgsConfig['options'] = {},
): ParseRunConfigResult {
  const { values } = parseArgs({
    args: argv,
    options: { ...RUN_OPTIONS, ...extraOptions },
    strict: false,
  });

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

  // 2) Resolve samples path: CLI > config > auto-detect .json/.yaml/.yml in cwd.
  const cliSamples = values.samples as string | undefined;
  let samplesFile: string;
  if (cliSamples) {
    samplesFile = cliSamples;
  } else if (evalConfig?.samples) {
    samplesFile = evalConfig.samples;  // already resolved against config file dir
  } else {
    samplesFile = 'eval-samples.json';
    if (!existsSync(resolve(samplesFile))) {
      if (existsSync(resolve('eval-samples.yaml'))) samplesFile = 'eval-samples.yaml';
      else if (existsSync(resolve('eval-samples.yml'))) samplesFile = 'eval-samples.yml';
    }
  }

  const skillDir: string = resolve((values['skill-dir'] as string | undefined) ?? 'skills');

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
  } else if (values.each) {
    // --each 模式自动用 baseline (control) vs 每个 skill (treatment),
    // 不需要用户显式传 --control / --treatment,校验跳过。
    variantSpecs = [];
  } else {
    const discovered = discoverVariants(skillDir);
    const hint = discovered.length > 0 ? `\n  skill-dir (${skillDir}) 下发现的候选：${discovered.join(', ')}` : '';
    throw new Error(
      `请通过 --control / --treatment 或 --config eval.yaml 声明 variant 角色。\n`
      + `  示例：omk bench run --control baseline --treatment my-skill${hint}\n`
      + `  --each 模式下自动用 baseline vs 每个 skill,无需显式声明\n`
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
  const judgeExecutorName =
    (values['judge-executor'] as string | undefined) ?? evalConfig?.judgeExecutor ?? executorName;
  const model = (values.model as string | undefined) ?? evalConfig?.model ?? 'sonnet';
  const judgeModelRaw =
    values['judge-model'] !== undefined
      ? (values['judge-model'] as string | undefined)
      : evalConfig?.judgeModel ?? 'haiku';
  const judgeModel = judgeModelRaw ?? 'haiku';
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
  const noJudge = (values['no-judge'] as boolean | undefined) ?? false;
  const noCache = (values['no-cache'] as boolean | undefined) ?? evalConfig?.noCache ?? false;
  const dryRun = (values['dry-run'] as boolean | undefined) ?? false;
  const skipPreflight = (values['skip-preflight'] as boolean | undefined) ?? false;
  const mcpConfig = (values['mcp-config'] as string | undefined) ?? evalConfig?.mcpConfig;
  const verbose = (values.verbose as boolean | undefined) ?? false;
  const retry = Math.max(0, Number(values.retry ?? 0) || 0);
  const resume = values.resume as string | undefined;
  const blind = (values.blind as boolean | undefined) ?? evalConfig?.blind ?? false;
  const layeredStats = (values['layered-stats'] as boolean | undefined) ?? false;

  // strict-baseline default true. Reconcile both flag forms.
  // Priority: --no-strict-baseline > --strict-baseline > undefined(=true).
  const noStrictFlag = values['no-strict-baseline'] as boolean | undefined;
  const strictFlag = values['strict-baseline'] as boolean | undefined;
  const strictBaseline: boolean = noStrictFlag === true ? false : (strictFlag ?? true);

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

  return {
    values,
    config: {
      samplesPath: resolve(samplesFile),
      skillDir,
      variantSpecs,
      model,
      judgeModel,
      outputDir,
      noJudge,
      noCache,
      dryRun,
      concurrency,
      timeoutMs,
      executorName,
      judgeExecutorName,
      skipPreflight,
      mcpConfig,
      verbose,
      retry,
      resume,
      blind,
      layeredStats,
      budget: evalConfig?.budget,
      strictBaseline,
      ...(Object.keys(variantAllowedSkills).length > 0 && { variantAllowedSkills }),
    },
  };
}
