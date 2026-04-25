#!/usr/bin/env node

import { parseArgs, type ParseArgsConfig } from 'node:util';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { discoverVariants, parseVariantCwd } from './inputs/skill-loader.js';
import { loadEvalConfig, configVariantsToSpecs } from './inputs/eval-config.js';
import type {
  EvalConfig,
  Report,
  VariantSpec,
  VariantSummary,
  GitInfo,
  ReportStore,
  ProgressCallback,
} from './types.js';

// ---------------------------------------------------------------------------
// Local types (CLI-specific, not shared with lib/)
// ---------------------------------------------------------------------------

interface RunConfig {
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
  judgeModels?: import('./types.js').JudgeConfig[];
  /** --bootstrap. Adds bootstrap CI to summary (per-variant mean + pairwise diff). */
  bootstrap?: boolean;
  /** --bootstrap-samples N. Bootstrap resamples count, default 1000. */
  bootstrapSamples?: number;
  /** v0.21 Phase 3a length-debias toggle. Default true; --no-debias-length sets false. */
  lengthDebias?: boolean;
  /** v0.22 — hard budget caps from CLI or config. */
  budget?: import('./types.js').EvalBudget;
  onProgress?: ProgressCallback | null;
}

// CLI progress info — superset of all possible fields from ProgressInfo union members
interface ProgressInfo {
  phase: string;
  completed?: number;
  total?: number;
  sample_id?: string;
  variant?: string;
  strategy?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
  score?: number;
  outputPreview?: string | null;
  jobId?: string;
  judgePhase?: string;
  judgeDim?: string;
  skipped?: boolean;
  attempt?: number;
  maxAttempts?: number;
  error?: string;
}

interface SkillProgressInfo {
  phase: string;
  skill: string;
  current: number;
  total: number;
}

interface RepeatProgressInfo {
  run: number;
  total: number;
}

interface RoundProgressInfo {
  round: number;
  totalRounds: number;
  phase: string;
  score?: number;
  delta?: number;
  accepted?: boolean;
  costUSD?: number;
  error?: string;
}

interface EvalResult {
  report: Report;
  filePath: string | null;
}

interface ReportServer {
  start: () => Promise<string>;
}

interface TrajectoryEntry {
  round: number;
  score: number;
  delta: number;
  accepted: boolean;
  costUSD: number;
}

interface EvolveResult {
  startScore: number;
  finalScore: number;
  bestRound: number;
  totalRounds: number;
  totalCostUSD: number;
  trajectory: TrajectoryEntry[];
  bestSkillPath: string;
  allVersions: string[];
  reportId?: string;
}

interface GenerateSamplesResult {
  samples: unknown[];
  costUSD: number;
}

interface ParseRunConfigResult {
  values: Record<string, string | boolean | undefined>;
  config: RunConfig;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_REPORTS_DIR: string = join(homedir(), '.oh-my-knowledge', 'reports');

// Shared CLI options for run/ci commands.
// Defaults are applied inside parseRunConfig (after config-file merge) so that
// CLI `undefined` can be reliably distinguished from "user passed the default value".
// Priority order resolved in parseRunConfig: CLI arg > --config file > hard-coded default.
const RUN_OPTIONS: ParseArgsConfig['options'] = {
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
};

// ---------------------------------------------------------------------------
// parseRunConfig
// ---------------------------------------------------------------------------

function parseRunConfig(
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
    },
  };
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP: string = `
oh-my-knowledge — Knowledge artifact evaluation toolkit

Usage:
  omk bench run [options]     Run an evaluation
  omk bench report [options]  Start the report server
  omk bench ci [options]      Run evaluation and exit with pass/fail code
  omk bench init [dir]        Scaffold a new eval project
  omk bench gen-samples [skill]  Generate eval-samples from skill content
  omk bench diff <id1> <id2>      Compare two evaluation reports
  omk bench evolve <skill>       Self-improve a skill through iterative evaluation

  omk analyze <dir>           Analyze cc session trace(s), produce skill 健康度日报 (v0.18)

Options for "bench run":

  --samples <path>       Sample file (default: eval-samples.json)
  --skill-dir <path>     Skill definitions directory (default: skills)
  --control <expr>       Control-group variant expression (experiment role = control)
  --treatment <v1,v2>    Treatment-group variant expressions (comma-separated; role = treatment)
                         Each variant expression resolves to an artifact and optional runtime context:
                           "baseline"       — bare model, no artifact injected
                           "git:name"       — artifact from last commit
                           "git:ref:name"   — artifact from specific commit
                           path with "/"    — artifact from file directly (e.g. ./v1.md)
                           "name@/cwd"      — attach runtime context / cwd
                         At least one of --control / --treatment must be provided.
  --config <path>        YAML/JSON config file (evaluation-as-code).
                         Declares samples + variants + model + executor in one file.
                         CLI flags override config fields when both are provided.
                         Relative paths inside the config are resolved against its directory.
  --model <name>         Model under test (default: sonnet)
  --judge-model <name>   Judge model (default: haiku)
  --output-dir <path>    Report output directory (default: ~/.oh-my-knowledge/reports/)
  --no-judge             Skip LLM judging
  --no-cache             Disable result caching
  --dry-run              Preview tasks without executing
  --blind                Blind A/B mode: hide variant names in report
  --concurrency <n>      Number of parallel tasks (default: 1)
  --timeout <seconds>    Executor timeout per task in seconds (default: 120)
  --repeat <n>           Run evaluation N times for variance analysis (default: 1)
  --judge-repeat <n>     Call LLM judge N times per (sample × dimension) for self-
                         consistency (default: 1). High stddev across runs = the
                         judge is unstable on this rubric and the score is noisy.
  --judge-models <list>  Multi-judge ensemble. Comma-separated executor:model pairs,
                         e.g. claude:opus,openai:gpt-4o,gemini:pro. Each judge scores
                         every (sample × dimension); report includes per-judge break-
                         down + Pearson/MAD inter-judge agreement. Refutes "Claude
                         judge Claude same-modality bias" critique. Combines with
                         --judge-repeat. Cost ~ N_judges × N_repeat × N_samples.
  --bootstrap            Compute bootstrap confidence intervals (distribution-free,
                         preferred over t-interval for ordinal LLM scores). Adds
                         per-variant CI on the mean + pairwise CI on treatment-vs-
                         control difference (significant=0 outside CI). Reports both
                         t-interval and bootstrap so old tooling still works.
  --bootstrap-samples <n>  Number of bootstrap resamples (default 1000). N>10000
                         triggers a stderr warning about runtime cost.
  --retry <n>            Retry failed tasks up to N times with exponential backoff (default: 0)
  --resume <report-id>   Resume from a previous report, skipping completed tasks
  --executor <name>      Executor: claude, openai, gemini, anthropic-api, openai-api,
                         or any shell command (e.g. "python my_provider.py")
  --judge-executor <name> Executor for LLM judge (default: same as --executor)
  --each                 Evaluate each skill independently against baseline
                         Requires {name}.eval-samples.json paired with each skill
  --skip-preflight       Skip model connectivity check before evaluation
  --mcp-config <path>    MCP config file for URL fetching via MCP servers
                         (default: .mcp.json in current directory)
  --no-serve             Skip auto-starting report server after evaluation
  --verbose              Print detailed progress for each sample (exec result, grading phases)
  --layered-stats        Expand the three-layer (fact/behavior/judge) independent
                         significance breakdown in the HTML report by default.
                         Without this flag, the breakdown is collapsed behind a
                         click-to-expand summary under each comparison.

Options for "bench ci":
  (same as "bench run", plus:)
  --threshold <number>   Minimum score to pass, applied INDEPENDENTLY to each of
                         the three layers (fact / behavior / LLM judge). ANY
                         layer below threshold fails the gate — this prevents
                         composite averaging from masking a single-layer collapse.
                         Default: 3.5. If all three layers are absent (no
                         assertions and no rubric defined in eval-samples), the
                         gate FAILS with a configuration hint — no composite fallback.

Options for "bench report":
  --port <number>        Server port (default: 7799)
  --reports-dir <path>   Reports directory (default: ~/.oh-my-knowledge/reports/)
  --export <id>          Export report as standalone HTML file
  --dev                  Dev mode: auto-restart on lib/ file changes

Options for "bench gen-samples":
  --each                 Generate for all skills missing eval-samples
  --count <n>            Number of samples to generate per skill (default: 5)
  --model <name>         Model for generation (default: sonnet)
  --skill-dir <path>     Skill directory (default: skills), used with --each

Options for "analyze":
  <dir>                  Input: cc session JSONL file / dir (e.g. ~/.claude/projects/<slug>)
  --kb <path>            Knowledge base root (default: auto-infer from trace cwd)
  --last <duration>      Time window like "7d" / "30d" (default: all)
  --from <iso>           Window start (ISO8601), takes precedence over --last
  --to <iso>             Window end (ISO8601), takes precedence over --last
  --skills <n1,n2,...>   Whitelist skills to analyze (default: all)
  --output-dir <path>    Output dir (default: ~/.oh-my-knowledge/analyses/)

Options for "bench evolve":
  --rounds <n>           Maximum evolution rounds (default: 5)
  --target <score>       Stop early when score reaches this threshold
  --samples <path>       Sample file (default: eval-samples.json)
  --model <name>         Model under test (default: sonnet)
  --judge-model <name>   Judge model (default: haiku)
  --improve-model <name> Model for generating improvements (default: sonnet)
  --concurrency <n>      Parallel eval tasks (default: 1)
  --timeout <seconds>    Executor timeout per task in seconds (default: 120)
  --executor <name>      Executor to use (default: claude)

Examples:
  omk bench run --control v1 --treatment v2
  omk bench run --control baseline --treatment my-skill
  omk bench run --control git:my-skill --treatment my-skill
  omk bench run --control ./old-skill.md --treatment ./new-skill.md
  omk bench run --control baseline --treatment v1,v2,v3
  omk bench run --config eval.yaml
  omk bench run --config eval.yaml --model sonnet-4.6   # CLI overrides config
  omk bench run --each
  omk bench run --dry-run
  omk bench report --port 8080
  omk bench report --export v1-vs-v2-20260326-1832
  omk bench init my-eval
  omk bench gen-samples skills/my-skill.md
  omk bench gen-samples --each
  omk bench diff <report-id-1> <report-id-2>
  omk bench evolve skills/my-skill.md --rounds 5
  omk analyze ~/.claude/projects/-Users-lizhiyao-Documents-oh-my-knowledge
  omk analyze ~/.claude/projects/my-project --last 7d --kb /path/to/project
  omk analyze ~/.claude/projects/my-project --skills audit,polish
`.trim();

// ---------------------------------------------------------------------------
// Update check
// ---------------------------------------------------------------------------

async function checkUpdate(): Promise<void> {
  try {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const __dirname: string = dirname(fileURLToPath(import.meta.url));
    const pkg: { name: string; version: string; publishConfig?: { registry?: string } } =
      JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
    const registry: string = pkg.publishConfig?.registry || 'https://registry.npmjs.org';
    const res: Response = await fetch(`${registry}/${pkg.name}/latest`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return;
    const data = await res.json() as { version?: string };
    if (data.version && data.version !== pkg.version) {
      process.stderr.write(`\n💡 新版本可用: ${pkg.version} → ${data.version}，运行 npm update ${pkg.name} -g 更新\n\n`);
    }
  } catch { /* 静默失败，不影响正常使用 */ }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  checkUpdate();
  const [domain, command, ...rest]: string[] = process.argv.slice(2);

  if (!domain || domain === '--help' || domain === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  if (domain === 'analyze') {
    const args = command ? [command, ...rest] : [];
    await handleAnalyze(args);
    return;
  }

  if (domain !== 'bench') {
    console.error(`Unknown domain: ${domain}. Use "omk bench <command>" or "omk analyze <dir>".`);
    process.exit(1);
  }

  if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  switch (command) {
    case 'run':
      await handleRun(rest);
      break;
    case 'report':
      await handleReport(rest);
      break;
    case 'init':
      await handleInit(rest);
      break;
    case 'ci':
      await handleCi(rest);
      break;
    case 'gen-samples':
      await handleGenSamples(rest);
      break;
    case 'evolve':
      await handleEvolve(rest);
      break;
    case 'diff':
      await handleDiff(rest);
      break;
    case 'gold':
      await handleGold(rest);
      break;
    case 'debias-validate':
      await handleDebiasValidate(rest);
      break;
    case 'saturation':
      await handleSaturation(rest);
      break;
    case 'verdict':
      await handleVerdict(rest);
      break;
    case 'diagnose':
      await handleDiagnose(rest);
      break;
    case 'failures':
      await handleFailures(rest);
      break;
    default:
      console.error(`Unknown command: bench ${command}. Use "run", "report", "ci", "init", "gen-samples", "evolve", "diff", "gold", "debias-validate", "saturation", "verdict", "diagnose", or "failures".`);
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Progress callback
// ---------------------------------------------------------------------------

function defaultOnProgress({
  phase,
  completed,
  total,
  sample_id,
  variant,
  durationMs,
  inputTokens,
  outputTokens,
  costUSD,
  score,
  outputPreview,
  judgePhase: _judgePhase,
  judgeDim,
  skipped,
  attempt,
  maxAttempts,
  error,
}: ProgressInfo): void {
  if (phase === 'preflight') {
    process.stderr.write('⏳ 预检模型连通性...\n');
    return;
  }
  if (phase === 'retry') {
    process.stderr.write(`[${completed}/${total}] ${sample_id}/${variant} 🔄 重试 ${attempt}/${maxAttempts}...\n`);
    return;
  }
  if (phase === 'error') {
    process.stderr.write(`[${completed}/${total}] ${sample_id}/${variant} ❌ ${error}\n`);
    return;
  }
  if (phase === 'start') {
    process.stderr.write(`[${completed}/${total}] ${sample_id}/${variant} ⏳ 执行中...\n`);
  } else if (phase === 'exec_done') {
    const costInfo: string = costUSD != null && costUSD > 0 ? ` $${costUSD.toFixed(4)}` : '';
    process.stderr.write(`[${completed}/${total}] ${sample_id}/${variant} 执行完成 ${durationMs}ms ${inputTokens}+${outputTokens} tokens${costInfo}\n`);
    if (outputPreview) {
      process.stderr.write(`  输出预览: ${outputPreview.slice(0, 150).replace(/\n/g, ' ')}\n`);
    }
  } else if (phase === 'grading') {
    const dimInfo: string = judgeDim ? ` [${judgeDim}]` : '';
    process.stderr.write(`[${completed}/${total}] ${sample_id}/${variant} 评审中${dimInfo}...\n`);
  } else if (phase === 'judge_done') {
    const dimInfo: string = judgeDim ? ` [${judgeDim}]` : '';
    process.stderr.write(`[${completed}/${total}] ${sample_id}/${variant} 评审完成${dimInfo} score=${score}\n`);
  } else if (phase === 'done' && skipped) {
    if (sample_id) process.stderr.write(`[${completed}/${total}] ${sample_id}/${variant} ⏭ 已跳过（已有结果）\n`);
  } else {
    const costInfo: string = costUSD != null && costUSD > 0 ? ` $${costUSD.toFixed(4)}` : '';
    const scoreInfo: string = typeof score === 'number' ? ` score=${score}` : '';
    process.stderr.write(`[${completed}/${total}] ${sample_id}/${variant} ✓ ${durationMs}ms ${inputTokens}+${outputTokens} tokens${costInfo}${scoreInfo}\n`);
  }
}

// ---------------------------------------------------------------------------
// handleRun
// ---------------------------------------------------------------------------

async function handleRun(argv: string[]): Promise<void> {
  const { values, config } = parseRunConfig(argv, {
    blind: { type: 'boolean', default: false },
    repeat: { type: 'string', default: '1' },
    'judge-repeat': { type: 'string', default: '1' },
    'judge-models': { type: 'string' },
    bootstrap: { type: 'boolean', default: false },
    'bootstrap-samples': { type: 'string', default: '1000' },
    'gold-dir': { type: 'string' },
    'no-debias-length': { type: 'boolean', default: false },
    'budget-usd': { type: 'string' },
    'budget-per-sample-usd': { type: 'string' },
    'budget-per-sample-ms': { type: 'string' },
  });

  const { runEvaluation, runMultiple, runEachEvaluation } = await import('./eval-workflows/run-evaluation.js');

  config.blind = values.blind as boolean | undefined;
  config.onProgress = defaultOnProgress as unknown as ProgressCallback;

  // --repeat 诚实输入校验:非 ≥1 整数时提示并钳到 1,不静默掩盖用户错字/极端输入
  // 提前到 --each 分支之前,保证 each 模式也能读到 repeat (曾经 bug: --each 吞 --repeat)
  const repeatRaw = values.repeat as string | undefined;
  const parsedRepeat = repeatRaw !== undefined ? Number(repeatRaw) : 1;
  if (repeatRaw !== undefined && (!Number.isFinite(parsedRepeat) || parsedRepeat < 1)) {
    process.stderr.write(`⚠ --repeat "${repeatRaw}" 无效(期望 ≥ 1 的整数),已按 1 次评测执行\n`);
  }
  const repeatCount: number = Math.max(1, Math.floor(parsedRepeat) || 1);

  // --judge-repeat 同样的诚实校验:非 ≥1 整数时钳到 1
  const judgeRepeatRaw = values['judge-repeat'] as string | undefined;
  const parsedJudgeRepeat = judgeRepeatRaw !== undefined ? Number(judgeRepeatRaw) : 1;
  if (judgeRepeatRaw !== undefined && (!Number.isFinite(parsedJudgeRepeat) || parsedJudgeRepeat < 1)) {
    process.stderr.write(`⚠ --judge-repeat "${judgeRepeatRaw}" 无效(期望 ≥ 1 的整数),已按 1 次 judge 执行\n`);
  }
  const judgeRepeatCount: number = Math.max(1, Math.floor(parsedJudgeRepeat) || 1);
  if (judgeRepeatCount > 1) config.judgeRepeat = judgeRepeatCount;

  // --judge-models executor:model,executor:model,... -> JudgeConfig[]
  // 至少 2 个才进 ensemble 模式,1 个等同于 --judge-model
  const judgeModelsRaw = values['judge-models'] as string | undefined;
  if (judgeModelsRaw) {
    const parts = judgeModelsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const judges = parts.map((p) => {
      const [executor, ...modelParts] = p.split(':');
      const model = modelParts.join(':');
      if (!executor || !model) {
        throw new Error(`--judge-models 格式错误: "${p}",应为 "executor:model" (如 claude:opus)`);
      }
      return { executor, model };
    });
    if (judges.length >= 2) {
      config.judgeModels = judges;
    } else if (judges.length === 1) {
      // 单 judge 不走 ensemble,但允许这样写,等同于 --judge-model + --executor
      process.stderr.write(`ℹ --judge-models 只指定 1 个 judge (${judges[0].executor}:${judges[0].model}),不触发 ensemble。如需 ensemble 至少给 2 个。\n`);
    }
  }

  // --budget-usd / --budget-per-sample-usd / --budget-per-sample-ms:
  // v0.22 hard budget caps. CLI flags override config-file values. When the
  // total-USD cap is exceeded mid-run, remaining tasks are skipped and a
  // partial report is persisted with meta.budgetExhausted=true.
  const budgetUSD = values['budget-usd'] != null ? Number(values['budget-usd']) : undefined;
  const budgetPerSampleUSD = values['budget-per-sample-usd'] != null ? Number(values['budget-per-sample-usd']) : undefined;
  const budgetPerSampleMs = values['budget-per-sample-ms'] != null ? Number(values['budget-per-sample-ms']) : undefined;
  if (budgetUSD !== undefined || budgetPerSampleUSD !== undefined || budgetPerSampleMs !== undefined) {
    config.budget = {
      ...(budgetUSD !== undefined && Number.isFinite(budgetUSD) && budgetUSD >= 0 ? { totalUSD: budgetUSD } : {}),
      ...(budgetPerSampleUSD !== undefined && Number.isFinite(budgetPerSampleUSD) && budgetPerSampleUSD >= 0 ? { perSampleUSD: budgetPerSampleUSD } : {}),
      ...(budgetPerSampleMs !== undefined && Number.isFinite(budgetPerSampleMs) && budgetPerSampleMs >= 0 ? { perSampleMs: budgetPerSampleMs } : {}),
    };
  }

  // --no-debias-length: opt out of v0.21 Phase 3a length-controlled prompt.
  // Default behavior is debias-on (judge prompt v3-cot-length); flag flips it
  // off so historical reports (judgePromptHash from v2-cot era) can be reproduced.
  if (values['no-debias-length'] as boolean) {
    config.lengthDebias = false;
    process.stderr.write('ℹ --no-debias-length 已生效:judge prompt 退回 v2-cot,与 < v0.21 报告 hash 一致。\n');
  }

  // --bootstrap / --bootstrap-samples
  if (values.bootstrap as boolean) {
    config.bootstrap = true;
    const bsRaw = values['bootstrap-samples'] as string | undefined;
    const parsedBs = bsRaw !== undefined ? Number(bsRaw) : 1000;
    if (bsRaw !== undefined && (!Number.isFinite(parsedBs) || parsedBs < 100)) {
      process.stderr.write(`⚠ --bootstrap-samples "${bsRaw}" 无效(期望 ≥ 100 的整数),已按 1000 执行\n`);
    }
    const bsCount = Math.max(100, Math.floor(parsedBs) || 1000);
    if (bsCount > 10000) {
      process.stderr.write(`⚠ --bootstrap-samples ${bsCount} 较大,可能耗时数秒。1000 是业内标准,通常已够用。\n`);
    }
    config.bootstrapSamples = bsCount;
  }

  try {
    // --each mode: evaluate each skill independently
    if (values.each) {
      const { report, filePath } = await runEachEvaluation({
        ...config,
        repeat: repeatCount,
        onSkillProgress({ phase, skill, current, total }: SkillProgressInfo): void {
          if (phase === 'start') {
            process.stderr.write(`\n=== [${current}/${total}] Skill: ${skill} ===\n`);
          }
        },
      }) as EvalResult;
      console.log(JSON.stringify(report, null, 2));
      if (filePath) {
        process.stderr.write('\n✅ 批量评测完成\n');
        process.stderr.write(`📄 Report saved to: ${filePath}\n`);

        if (!values['no-serve'] && process.stdout.isTTY) {
          const { createReportServer } = await import('./server/report-server.js');
          const server: ReportServer = createReportServer({ reportsDir: config.outputDir });
          const serverUrl: string = await server.start();
          const reportUrl: string = `${serverUrl}/run/${report.id}`;
          process.stderr.write(`\n📊 Report server running at ${serverUrl}\n`);
          process.stderr.write(`👉 View report: ${reportUrl}\n`);
          process.stderr.write('\nPress Ctrl+C to stop the server\n');

          const { platform } = await import('node:os');
          const openCmd: string = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
          const { execFile: execFileCb } = await import('node:child_process');
          execFileCb(openCmd, [reportUrl], () => { });
        } else if (!values['no-serve']) {
          process.stderr.write('\n💡 非交互环境，已跳过 report server\n');
          process.stderr.write(`   查看报告: omk bench report --reports-dir ${config.outputDir}\n`);
        }
      }
      return;
    }

    let report: Report;
    let filePath: string | null;

    if (repeatCount > 1) {
      const result = await runMultiple({
        ...config,
        repeat: repeatCount,
        onRepeatProgress({ run, total }: RepeatProgressInfo): void {
          process.stderr.write(`\n=== Run ${run}/${total} ===\n`);
        },
      }) as { report: Report };
      report = result.report;
      filePath = null;
    } else {
      const result = (await runEvaluation(config)) as EvalResult;
      report = result.report;
      filePath = result.filePath;
    }

    // --gold-dir: compute α/κ/Pearson against gold annotations and re-persist.
    const goldDir = values['gold-dir'] as string | undefined;
    if (goldDir && filePath) {
      const { attachGoldAgreementToReport, formatGoldCompare } = await import('./grading/gold-cli.js');
      const out = attachGoldAgreementToReport({
        report,
        goldDir,
        outputDir: config.outputDir,
        samples: config.bootstrapSamples,
      });
      if (out.result && out.gold) {
        process.stderr.write(formatGoldCompare(out.result, out.gold));
        if (out.result.contaminationWarning) {
          process.stderr.write(`\n⚠ ${out.result.contaminationWarning}\n`);
        }
      } else {
        process.stderr.write(`\n⚠ gold dataset 加载失败 (${goldDir}):\n`);
        for (const m of out.loadIssues) process.stderr.write(`  - ${m}\n`);
      }
    }

    console.log(JSON.stringify(report, null, 2));
    if (filePath) {
      process.stderr.write('\n✅ 评测完成\n');
      process.stderr.write(`📄 Report saved to: ${filePath}\n`);

      if (!values['no-serve'] && process.stdout.isTTY) {
        // Auto-start report server
        const { createReportServer } = await import('./server/report-server.js');
        const server: ReportServer = createReportServer({
          reportsDir: config.outputDir,
        });
        const serverUrl: string = await server.start();
        const reportUrl: string = `${serverUrl}/run/${report.id}`;
        process.stderr.write(`\n📊 Report server running at ${serverUrl}\n`);
        process.stderr.write(`👉 View report: ${reportUrl}\n`);
        process.stderr.write('\nPress Ctrl+C to stop the server\n');

        // Auto-open report in browser
        const { platform } = await import('node:os');
        const openCmd: string = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
        const { execFile: execFileCb } = await import('node:child_process');
        execFileCb(openCmd, [reportUrl], () => { });
      } else if (!values['no-serve']) {
        process.stderr.write('\n💡 非交互环境，已跳过 report server\n');
        process.stderr.write(`   查看报告: omk bench report --reports-dir ${config.outputDir}\n`);
      }
    }
  } catch (err: unknown) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// handleReport
// ---------------------------------------------------------------------------

async function handleReport(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', default: '7799' },
      'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
      export: { type: 'string' },
      dev: { type: 'boolean', default: false },
    },
    strict: false,
  });

  // Dev mode: restart server on file changes via node --watch
  if (values.dev && !process.env.__OMK_DEV_CHILD) {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const cliPath: string = fileURLToPath(import.meta.url);
    const libDir: string = resolve(cliPath, '..', 'lib');
    const args: string[] = [
      '--watch-path', libDir, cliPath, 'bench', 'report',
      '--port', values.port as string,
      '--reports-dir', values['reports-dir'] as string,
    ];
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, __OMK_DEV_CHILD: '1' },
    });
    child.on('exit', (code: number | null) => process.exit(code || 0));
    return;
  }

  if (values.export) {
    const { createFileStore } = await import('./server/report-store.js');
    const { renderRunDetail, renderEachRunDetail } = await import('./renderer/html-renderer.js');
    const { writeFileSync } = await import('node:fs');
    const store: ReportStore = createFileStore(resolve(values['reports-dir'] as string));
    const report: Report | null = await store.get(values.export as string);
    if (!report) {
      console.error(`Report not found: ${values.export}`);
      process.exit(1);
    }
    const html: string = report!.each ? renderEachRunDetail(report) : renderRunDetail(report);
    const outPath: string = resolve(`${values.export}.html`);
    writeFileSync(outPath, html);
    console.log(`Exported to: ${outPath}`);
    console.log('Open in browser, or Ctrl+P to save as PDF');
    return;
  }

  const { createReportServer } = await import('./server/report-server.js');
  const server: ReportServer = createReportServer({
    port: Number(values.port),
    reportsDir: resolve(values['reports-dir'] as string),
  });

  const url: string = await server.start();
  console.log(`Report server running at ${url}`);
  console.log('Press Ctrl+C to stop');
}

// ---------------------------------------------------------------------------
// handleInit
// ---------------------------------------------------------------------------

const INIT_SAMPLES = `[
  {
    "sample_id": "s001",
    "prompt": "审查以下代码",
    "context": "function authenticate(username, password) {\\n  const query = \`SELECT * FROM users WHERE name='\${username}' AND pass='\${password}'\`;\\n  return db.execute(query);\\n}",
    "rubric": "应识别 SQL 注入风险，建议使用参数化查询",
    "assertions": [
      { "type": "contains", "value": "SQL", "weight": 1 },
      { "type": "contains", "value": "注入", "weight": 1 },
      { "type": "contains", "value": "参数化", "weight": 0.5 },
      { "type": "not_contains", "value": "没有问题", "weight": 0.5 }
    ],
    "dimensions": {
      "security": "是否准确识别出 SQL 注入漏洞并说明其危害",
      "actionability": "是否给出可直接使用的参数化查询修复代码"
    }
  },
  {
    "sample_id": "s002",
    "prompt": "审查以下代码",
    "context": "async function fetchData(url) {\\n  const res = await fetch(url);\\n  const data = await res.json();\\n  return data;\\n}",
    "rubric": "应指出缺少错误处理（网络异常、非 JSON 响应、HTTP 错误状态码）",
    "assertions": [
      { "type": "contains", "value": "错误处理", "weight": 1 },
      { "type": "regex", "pattern": "try[\\\\s\\\\S]*catch|错误|异常|error", "flags": "i", "weight": 1 },
      { "type": "contains", "value": "status", "weight": 0.5 }
    ],
    "dimensions": {
      "robustness": "是否指出了所有缺失的错误处理场景",
      "actionability": "是否给出了完整的 try-catch 修复代码"
    }
  },
  {
    "sample_id": "s003",
    "prompt": "审查以下代码",
    "context": "function renderComment(comment) {\\n  document.getElementById('output').innerHTML = '<p>' + comment + '</p>';\\n}",
    "rubric": "应识别 XSS 风险，建议使用 textContent 或转义 HTML",
    "assertions": [
      { "type": "contains", "value": "XSS", "weight": 1 },
      { "type": "regex", "pattern": "textContent|转义|escape|sanitize", "flags": "i", "weight": 1 },
      { "type": "contains", "value": "innerHTML", "weight": 0.5 }
    ],
    "dimensions": {
      "security": "是否准确识别出 XSS 漏洞并说明攻击方式",
      "actionability": "是否给出使用 textContent 或转义的修复代码"
    }
  }
]
`;

const INIT_SKILL_V1 = '你是一个代码审查助手。请审查用户提供的代码，指出潜在问题。';

const INIT_SKILL_V2 = `你是一个高级代码审查专家。请从以下维度审查用户提供的代码：

1. 安全性：是否存在注入、XSS、敏感信息泄露等风险
2. 健壮性：是否有适当的错误处理和边界检查
3. 可维护性：命名是否清晰、结构是否合理
4. 性能：是否存在明显的性能瓶颈

对每个维度给出具体的改进建议，并标注严重程度（高/中/低）。
`;

// ---------------------------------------------------------------------------
// handleAnalyze (v0.18 skill 健康度日报)
// ---------------------------------------------------------------------------

function parseLastWindow(spec: string): string | null {
  // "7d" / "24h" / "30m" → ISO timestamp (from = now - spec)
  const m = /^(\d+)([dhm])$/.exec(spec);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const ms = unit === 'd' ? n * 86400_000 : unit === 'h' ? n * 3600_000 : n * 60_000;
  return new Date(Date.now() - ms).toISOString();
}

async function handleAnalyze(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      kb: { type: 'string' },
      last: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      skills: { type: 'string' },
      'output-dir': { type: 'string' },
    },
  });
  const dir = positionals[0];
  if (!dir) {
    console.error('Usage: omk analyze <dir> [--kb <path>] [--last 7d] [--from ISO] [--to ISO] [--skills name1,name2]');
    process.exit(1);
  }
  const tracePath = resolve(dir);

  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
  if (!existsSync(tracePath)) {
    console.error(`Trace path does not exist: ${tracePath}`);
    process.exit(1);
  }

  // 时间窗: --from/--to 优先, --last fallback
  let from: string | undefined = values.from;
  if (!from && values.last) {
    const inferred = parseLastWindow(values.last);
    if (!inferred) {
      console.error(`Invalid --last format: "${values.last}". Expected e.g. "7d" / "24h" / "30m".`);
      process.exit(1);
    }
    from = inferred;
  }
  const to: string | undefined = values.to;
  const skills = values.skills ? values.skills.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

  console.log(`[omk] analyzing ${tracePath}...`);
  const { computeSkillHealthReport } = await import('./observability/skill-health-analyzer.js');
  const report = computeSkillHealthReport(tracePath, {
    kbRoot: values.kb ? resolve(values.kb) : undefined,
    from,
    to,
    skills,
  });

  // JSON 是主产物; HTML 由 report server 的 /analyses/:id 按需渲染 (和 bench run 一致)
  const outDir = resolve(values['output-dir'] || join(process.env.HOME || '.', '.oh-my-knowledge', 'analyses'));
  mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = join(outDir, `${timestamp}-skill-health.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  // 控制台摘要
  const { sessionCount, segmentCount, toolCallCount, toolFailureRate } = report.meta;
  console.log('');
  console.log(`sessions: ${sessionCount} · segments: ${segmentCount} · tool calls: ${toolCallCount} · fail rate: ${(toolFailureRate * 100).toFixed(1)}%`);
  console.log(`overall: gapRate ${(report.overall.gapRate * 100).toFixed(1)}% · weightedGapRate ${(report.overall.weightedGapRate * 100).toFixed(1)}% · health: ${report.overall.healthBand}`);
  console.log('');
  const skillRows = Object.values(report.bySkill)
    .sort((a, b) => b.segmentCount - a.segmentCount)
    .slice(0, 10)
    .map((s) => `  ${s.skillName.padEnd(24)} segs=${String(s.segmentCount).padStart(4)}  gapRate=${String(Math.round(s.gap.gapRate * 100) + '%').padStart(4)}  weighted=${String(Math.round(s.gap.weightedGapRate * 100) + '%').padStart(4)}${s.coverage ? `  cov=${Math.round(s.coverage.fileCoverageRate * 100)}%` : ''}`);
  console.log('top skills:');
  console.log(skillRows.join('\n'));
  console.log('');
  console.log(`report written to: ${jsonPath}`);
  console.log(`view in browser: omk bench report  # 打开后点首页的 "📊 Skill 健康度日报"`);
}

async function handleInit(argv: string[]): Promise<void> {
  const targetDir: string = resolve(argv[0] || '.');
  const { writeFileSync, mkdirSync } = await import('node:fs');

  mkdirSync(join(targetDir, 'skills'), { recursive: true });
  writeFileSync(join(targetDir, 'eval-samples.json'), INIT_SAMPLES);
  writeFileSync(join(targetDir, 'skills', 'v1.md'), INIT_SKILL_V1);
  writeFileSync(join(targetDir, 'skills', 'v2.md'), INIT_SKILL_V2);

  console.log(`Eval project scaffolded at: ${targetDir}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Edit eval-samples.json to add your test cases');
  console.log('  2. Edit skills/v1.md and skills/v2.md with your skill versions');
  console.log('  3. Run: omk bench run --control v1 --treatment v2');
}

// ---------------------------------------------------------------------------
// handleGenSamples
// ---------------------------------------------------------------------------

async function handleGenSamples(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      each: { type: 'boolean', default: false },
      count: { type: 'string', default: '5' },
      model: { type: 'string', default: 'sonnet' },
      'skill-dir': { type: 'string', default: 'skills' },
    },
    strict: false,
    allowPositionals: true,
  });

  const { generateSamples } = await import('./authoring/generator.js');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const count: number = Math.max(1, Number(values.count) || 5);
  const model: string = values.model as string;

  if (values.each) {
    // Batch mode: generate for all skills missing eval-samples
    const skillDir: string = resolve(values['skill-dir'] as string);
    if (!existsSync(skillDir)) {
      console.error(`Skill directory not found: ${skillDir}`);
      process.exit(1);
    }

    const { readdirSync, statSync } = await import('node:fs');
    const entries: string[] = readdirSync(skillDir);
    let generated: number = 0;

    for (const entry of entries) {
      let name: string;
      let skillPath: string;
      let samplesPath: string;
      const fullPath: string = join(skillDir, entry);

      if (entry.endsWith('.md') && !entry.endsWith('.eval-samples.json')) {
        name = entry.slice(0, -3);
        skillPath = fullPath;
        samplesPath = join(skillDir, `${name}.eval-samples.json`);
      } else if (statSync(fullPath).isDirectory()) {
        const skillMd: string = join(fullPath, 'SKILL.md');
        if (!existsSync(skillMd)) continue;
        name = entry;
        skillPath = skillMd;
        samplesPath = join(fullPath, 'eval-samples.json');
      } else {
        continue;
      }

      if (existsSync(samplesPath)) {
        process.stderr.write(`⏭️  ${name}: eval-samples 已存在，跳过\n`);
        continue;
      }

      process.stderr.write(`🔄 ${name}: 正在生成 ${count} 个测试样本...\n`);
      try {
        const skillContent: string = readFileSync(skillPath, 'utf-8');
        const { samples, costUSD }: GenerateSamplesResult =
          await generateSamples({ skillContent, count, model });
        writeFileSync(samplesPath, JSON.stringify(samples, null, 2));
        process.stderr.write(`✅ ${name}: 已生成 ${samples.length} 个样本 → ${samplesPath} (${costUSD > 0 ? `$${costUSD.toFixed(4)}` : ''})\n`);
        generated++;
      } catch (err: unknown) {
        process.stderr.write(`❌ ${name}: ${(err as Error).message}\n`);
      }
    }

    if (generated === 0) {
      console.log('没有需要生成的 eval-samples（所有 skill 已有配对文件）');
    } else {
      console.log(`\n共生成 ${generated} 份 eval-samples，请审查后运行: omk bench run --each`);
    }
  } else {
    // Single skill mode
    const skillPath: string | undefined = argv.find((a: string) => !a.startsWith('-'));
    if (!skillPath) {
      console.error('请指定 skill 文件路径，例如: omk bench gen-samples skills/my-skill.md');
      process.exit(1);
    }

    const resolvedPath: string = resolve(skillPath);
    if (!existsSync(resolvedPath)) {
      console.error(`Skill file not found: ${resolvedPath}`);
      process.exit(1);
    }

    const skillContent: string = readFileSync(resolvedPath, 'utf-8');
    const outputPath: string = resolve('eval-samples.json');

    if (existsSync(outputPath)) {
      console.error(`eval-samples.json 已存在。如需覆盖请先删除。`);
      process.exit(1);
    }

    process.stderr.write(`🔄 正在生成 ${count} 个测试样本...\n`);
    try {
      const { samples, costUSD }: GenerateSamplesResult =
        await generateSamples({ skillContent, count, model });
      writeFileSync(outputPath, JSON.stringify(samples, null, 2));
      process.stderr.write(`✅ 已生成 ${samples.length} 个样本 → ${outputPath} (${costUSD > 0 ? `$${costUSD.toFixed(4)}` : ''})\n`);
      console.log('\n请审查生成的测试样本后运行: omk bench run');
    } catch (err: unknown) {
      console.error(`生成失败: ${(err as Error).message}`);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// handleEvolve
// ---------------------------------------------------------------------------

async function handleEvolve(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      rounds: { type: 'string', default: '5' },
      target: { type: 'string' },
      samples: { type: 'string', default: 'eval-samples.json' },
      model: { type: 'string', default: 'sonnet' },
      'judge-model': { type: 'string', default: 'haiku' },
      'improve-model': { type: 'string', default: 'sonnet' },
      concurrency: { type: 'string', default: '1' },
      timeout: { type: 'string', default: '120' },
      executor: { type: 'string', default: 'claude' },
      'skip-preflight': { type: 'boolean', default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  const skillPath: string | undefined = argv.find((a: string) => !a.startsWith('-'));
  if (!skillPath) {
    console.error('请指定 skill 文件路径，例如: omk bench evolve skills/my-skill.md');
    process.exit(1);
  }

  let samplesFile: string = (values.samples as string) ?? 'eval-samples.json';
  if (samplesFile === 'eval-samples.json' && !existsSync(resolve(samplesFile))) {
    if (existsSync(resolve('eval-samples.yaml'))) samplesFile = 'eval-samples.yaml';
    else if (existsSync(resolve('eval-samples.yml'))) samplesFile = 'eval-samples.yml';
  }

  const { evolveSkill } = await import('./authoring/evolver.js');

  process.stderr.write(`\n=== Evolution: ${skillPath} ===\n`);

  try {
    const result: EvolveResult = await evolveSkill({
      skillPath: resolve(skillPath),
      samplesPath: resolve(samplesFile),
      rounds: Math.max(1, Number(values.rounds) || 5),
      target: values.target ? Number(values.target) : null,
      model: values.model as string,
      judgeModel: values['judge-model'] as string,
      improveModel: values['improve-model'] as string,
      executorName: values.executor as string,
      concurrency: Math.max(1, Number(values.concurrency) || 1),
      timeoutMs: Math.max(1, Number(values.timeout) || 120) * 1000,
      skipPreflight: values['skip-preflight'] as boolean,
      onProgress: defaultOnProgress as unknown as ProgressCallback,
      onRoundProgress({ round, totalRounds: _totalRounds, phase, score, delta, accepted, costUSD, error }: RoundProgressInfo): void {
        if (phase === 'baseline') {
          process.stderr.write(`Round 0 (baseline): score=${score!.toFixed(2)} ($${costUSD!.toFixed(4)})\n`);
        } else if (phase === 'error') {
          process.stderr.write(`Round ${round}: ✗ 改进生成失败: ${error}\n`);
        } else if (phase === 'done') {
          const deltaStr: string = delta! >= 0 ? `+${delta!.toFixed(2)}` : delta!.toFixed(2);
          const status: string = accepted ? '✓ ACCEPT' : '✗ REJECT';
          process.stderr.write(`Round ${round}: score=${score!.toFixed(2)} (${deltaStr}) ${status} ($${costUSD!.toFixed(4)})\n`);
        }
      },
    });

    const improvement: string = result.startScore > 0
      ? ((result.finalScore - result.startScore) / result.startScore * 100).toFixed(1)
      : '0';
    process.stderr.write(`\n✅ ${result.startScore.toFixed(2)} → ${result.finalScore.toFixed(2)} (+${improvement}%) | ${result.totalRounds} 轮 | $${result.totalCostUSD.toFixed(4)}\n`);
    process.stderr.write(`Best: ${result.bestSkillPath} → ${resolve(skillPath)}\n`);
    process.stderr.write(`所有版本保存在: ${join(resolve(skillPath, '..'), 'evolve')}/\n`);
    if (result.reportId) {
      process.stderr.write(`📊 评测报告: omk bench report (ID: ${result.reportId})\n`);
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (err: unknown) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// handleCi
// ---------------------------------------------------------------------------

async function handleCi(argv: string[]): Promise<void> {
  const { values, config } = parseRunConfig(argv, {
    threshold: { type: 'string', default: '3.5' },
  });

  const { runEvaluation } = await import('./eval-workflows/run-evaluation.js');

  config.onProgress = defaultOnProgress as unknown as ProgressCallback;

  try {
    const { report } = (await runEvaluation(config)) as EvalResult;

    const threshold: number = Number(values.threshold);

    if ((report as Report & { dryRun?: boolean }).dryRun) {
      console.log('CI dry-run: no scores to check');
      process.exit(0);
    }

    // three-gate 逻辑抽到 src/eval-core/ci-gates.ts 作纯函数,便于测试;此处只做 IO。
    const { evaluateCiGates } = await import('./eval-core/ci-gates.js');
    const { allPass, lines } = evaluateCiGates(report.summary || {}, threshold);
    for (const line of lines) console.log(line);
    process.exit(allPass ? 0 : 1);
  } catch (err: unknown) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// handleDiff
// ---------------------------------------------------------------------------

async function handleDiff(argv: string[]): Promise<void> {
  // Flag-aware split: separate positional report IDs from flags so we can support
  //   omk bench diff <id>                      — within-report sample-level (v0.22)
  //   omk bench diff <id1> <id2>               — cross-report variant-level (legacy)
  // both with optional --regressions-only / --threshold / --variant flags.
  const positional: string[] = [];
  const flagArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      flagArgs.push(a);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flagArgs.push(next);
        i++;
      }
    } else {
      positional.push(a);
    }
  }

  if (positional.length === 0) {
    console.error([
      'Usage:',
      '  omk bench diff <reportId>                     within-report per-sample diff (v0.22)',
      '  omk bench diff <reportId1> <reportId2>        cross-report variant-level diff',
      '',
      'Options:',
      '  --regressions-only          只列 treatment < control 的样本',
      '  --threshold <num>           regression 阈值 (default 0,即任一负 Δ 算回退)',
      '  --variant <name>            within-report 模式下指定要钻取的 variant (default: variants[1])',
      '  --top <n>                   只列差距最大的前 N 个样本',
    ].join('\n'));
    process.exit(positional.length === 0 ? 1 : 0);
  }

  const { values } = parseArgs({
    args: flagArgs,
    options: {
      'regressions-only': { type: 'boolean', default: false },
      threshold: { type: 'string' },
      variant: { type: 'string' },
      top: { type: 'string' },
    },
    strict: false,
  });

  const { createFileStore } = await import('./server/report-store.js');
  const store: ReportStore = createFileStore(resolve(DEFAULT_REPORTS_DIR));

  if (positional.length === 1) {
    await runSampleLevelDiff(positional[0], store, values);
    return;
  }

  const [id1, id2]: string[] = positional;
  const r1: Report | null = await store.get(id1);
  const r2: Report | null = await store.get(id2);

  if (!r1) { console.error(`Report not found: ${id1}`); process.exit(1); }
  if (!r2) { console.error(`Report not found: ${id2}`); process.exit(1); }

  console.log(`\n  Diff: ${id1} → ${id2}\n`);

  // Git info — r1/r2 are guaranteed non-null after process.exit() guards above
  const g1: GitInfo | null | undefined = r1!.meta?.gitInfo;
  const g2: GitInfo | null | undefined = r2!.meta?.gitInfo;
  if (g1 || g2) {
    console.log(`  Git:  ${g1?.commitShort || '?'}${g1?.dirty ? '*' : ''} (${g1?.branch || '?'}) → ${g2?.commitShort || '?'}${g2?.dirty ? '*' : ''} (${g2?.branch || '?'})`);
  }

  // Per-variant comparison
  const variants: string[] = [...new Set([...(r1!.meta?.variants || []), ...(r2!.meta?.variants || [])])];
  for (const v of variants) {
    const s1: VariantSummary | undefined = r1!.summary?.[v];
    const s2: VariantSummary | undefined = r2!.summary?.[v];
    if (!s1 && !s2) continue;

    console.log(`\n  [${v}]`);

    const score1: number | string = s1?.avgCompositeScore ?? '-';
    const score2: number | string = s2?.avgCompositeScore ?? '-';
    const scoreDelta: string = typeof score1 === 'number' && typeof score2 === 'number'
      ? ` (${score2 > score1 ? '+' : ''}${(score2 - score1).toFixed(2)})`
      : '';
    console.log(`    Score:   ${score1} → ${score2}${scoreDelta}`);

    const turns1: number | string = s1?.avgNumTurns ?? '-';
    const turns2: number | string = s2?.avgNumTurns ?? '-';
    console.log(`    Turns:   ${turns1} → ${turns2}`);

    // Tool calls comparison (agent metrics)
    if (s1?.avgToolCalls != null || s2?.avgToolCalls != null) {
      const tc1: number | string = s1?.avgToolCalls ?? '-';
      const tc2: number | string = s2?.avgToolCalls ?? '-';
      console.log(`    Tools:   ${tc1} → ${tc2}`);
      const sr1 = s1?.toolSuccessRate != null ? `${(s1.toolSuccessRate * 100).toFixed(0)}%` : '-';
      const sr2 = s2?.toolSuccessRate != null ? `${(s2.toolSuccessRate * 100).toFixed(0)}%` : '-';
      console.log(`    ToolOK:  ${sr1} → ${sr2}`);
    }

    const cost1: number = s1?.avgCostPerSample ?? 0;
    const cost2: number = s2?.avgCostPerSample ?? 0;
    const costPct: string = cost1 > 0 ? ` (${cost2 > cost1 ? '+' : ''}${(((cost2 - cost1) / cost1) * 100).toFixed(0)}%)` : '';
    console.log(`    Cost:    $${cost1.toFixed(4)} → $${cost2.toFixed(4)}${costPct}`);

    // Skill hash change
    const h1: string | undefined = r1!.meta?.artifactHashes?.[v];
    const h2: string | undefined = r2!.meta?.artifactHashes?.[v];
    if (h1 && h2 && h1 !== h2) {
      console.log(`    Skill:   ${h1.slice(0, 8)} → ${h2.slice(0, 8)} (changed)`);
    }
  }

  console.log('');
}

/**
 * Within-report sample-level diff (v0.22). Compares two variants' scores on
 * each shared sample and surfaces the worst regressions / biggest wins.
 *
 * Default focus is variants[0] (control) vs variants[1] (treatment), but
 * `--variant` overrides which variant is the "treatment" side.
 */
async function runSampleLevelDiff(
  reportId: string,
  store: ReportStore,
  flags: Record<string, string | boolean | undefined>,
): Promise<void> {
  const report: Report | null = await store.get(reportId);
  if (!report) {
    console.error(`Report not found: ${reportId}`);
    process.exit(1);
  }
  const variants = report!.meta?.variants ?? [];
  if (variants.length < 2) {
    console.error('Sample-level diff needs at least 2 variants in the report.');
    process.exit(1);
  }
  const control = variants[0];
  const treatment = (flags.variant as string | undefined) ?? variants[1];
  if (!variants.includes(treatment)) {
    console.error(`Variant "${treatment}" not in report. Available: ${variants.join(', ')}`);
    process.exit(1);
  }

  const threshold = flags.threshold != null ? Number(flags.threshold) : 0;
  const regressionsOnly = Boolean(flags['regressions-only']);
  const topN = flags.top != null ? Math.max(1, Number(flags.top) || 0) : undefined;

  const rows: Array<{ id: string; cFact?: number; tFact?: number; cBeh?: number; tBeh?: number; cJudge?: number; tJudge?: number; cComp: number; tComp: number; delta: number }> = [];
  for (const entry of report!.results ?? []) {
    const c = entry.variants?.[control];
    const t = entry.variants?.[treatment];
    if (!c || !t) continue;
    const cComp = c.compositeScore ?? c.llmScore ?? 0;
    const tComp = t.compositeScore ?? t.llmScore ?? 0;
    const delta = Number((tComp - cComp).toFixed(3));
    rows.push({
      id: entry.sample_id,
      cFact: c.layeredScores?.factScore, tFact: t.layeredScores?.factScore,
      cBeh: c.layeredScores?.behaviorScore, tBeh: t.layeredScores?.behaviorScore,
      cJudge: c.layeredScores?.judgeScore, tJudge: t.layeredScores?.judgeScore,
      cComp, tComp, delta,
    });
  }

  // Sort by |delta| desc so the most impactful rows surface first.
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  let filtered = rows;
  if (regressionsOnly) filtered = filtered.filter((r) => r.delta < threshold);
  if (topN !== undefined) filtered = filtered.slice(0, topN);

  console.log(`\n  Sample-level diff: ${treatment} vs ${control} (report ${reportId})`);
  if (regressionsOnly) console.log(`  Filter: regressions only (Δ < ${threshold})`);
  console.log('');
  console.log('  sample_id           Δ      composite (c→t)   fact (c→t)     behavior (c→t)   judge (c→t)');
  console.log('  ' + '-'.repeat(100));

  if (filtered.length === 0) {
    console.log(regressionsOnly ? '  (no regressions found)' : '  (no shared samples)');
    console.log('');
    return;
  }

  const fmt = (a: number | undefined, b: number | undefined): string => {
    const av = typeof a === 'number' ? a.toFixed(2) : '—';
    const bv = typeof b === 'number' ? b.toFixed(2) : '—';
    return `${av} → ${bv}`.padEnd(15);
  };
  for (const r of filtered) {
    const sign = r.delta > 0 ? '+' : '';
    const idCol = r.id.slice(0, 18).padEnd(20);
    const deltaCol = `${sign}${r.delta.toFixed(2)}`.padEnd(7);
    const compCol = `${r.cComp.toFixed(2)} → ${r.tComp.toFixed(2)}`.padEnd(17);
    console.log(`  ${idCol}${deltaCol}${compCol}${fmt(r.cFact, r.tFact)} ${fmt(r.cBeh, r.tBeh)} ${fmt(r.cJudge, r.tJudge)}`);
  }
  console.log('');
  console.log(`  Showing ${filtered.length} of ${rows.length} samples · sorted by |Δ|`);
  if (regressionsOnly) {
    const total = rows.length;
    const reg = rows.filter((r) => r.delta < threshold).length;
    console.log(`  Regression rate: ${reg}/${total} samples (${total > 0 ? ((reg / total) * 100).toFixed(0) : 0}%)`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// handleGold — gold dataset workflow (init / validate / compare)
// ---------------------------------------------------------------------------

async function handleGold(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === '--help' || sub === '-h') {
    console.log([
      '',
      'Usage: omk bench gold <subcommand>',
      '',
      'Subcommands:',
      '  init [--out <dir>] [--annotator <id>]    生成空白 gold dataset 模板',
      '  validate <dir>                           校验数据集结构',
      '  compare <reportId> --gold-dir <dir>      与已有 report 计算 α/κ/Pearson',
      '    [--variant <name>] [--reports-dir <d>]',
      '    [--bootstrap-samples N] [--seed N]',
      '',
    ].join('\n'));
    process.exit(sub ? 0 : 1);
  }

  if (sub === 'init') {
    const { values } = parseArgs({
      args: rest,
      options: {
        out: { type: 'string', default: './gold-dataset' },
        annotator: { type: 'string' },
      },
      strict: false,
    });
    const { initGoldDataset } = await import('./grading/gold-cli.js');
    try {
      const written = initGoldDataset(values.out as string, {
        annotator: values.annotator as string | undefined,
      });
      console.log(`Created ${written.length} files in ${values.out}:`);
      for (const p of written) console.log(`  ${p}`);
      console.log('\n下一步: 编辑 annotations.yaml 加入真实标注 → 跑 omk bench gold validate');
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    return;
  }

  if (sub === 'validate') {
    const dir = rest[0];
    if (!dir) {
      console.error('Usage: omk bench gold validate <dir>');
      process.exit(1);
    }
    const { validateGoldDataset } = await import('./grading/gold-cli.js');
    const result = validateGoldDataset(dir);
    if (result.ok) {
      console.log(`✓ gold dataset OK — ${result.sampleCount} 条标注`);
      return;
    }
    console.error(`✗ gold dataset has ${result.issues.length} issue(s):`);
    for (const msg of result.issues) console.error(`  - ${msg}`);
    process.exit(1);
  }

  if (sub === 'compare') {
    const reportId = rest[0];
    if (!reportId) {
      console.error('Usage: omk bench gold compare <reportId> --gold-dir <dir>');
      process.exit(1);
    }
    const { values } = parseArgs({
      args: rest.slice(1),
      options: {
        'gold-dir': { type: 'string' },
        variant: { type: 'string' },
        'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
        'bootstrap-samples': { type: 'string', default: '1000' },
        seed: { type: 'string' },
      },
      strict: false,
    });
    const goldDir = values['gold-dir'] as string | undefined;
    if (!goldDir) {
      console.error('--gold-dir is required');
      process.exit(1);
    }
    const { loadGoldDataset } = await import('./grading/gold-dataset.js');
    const { compareGoldToReport, formatGoldCompare } = await import('./grading/gold-cli.js');
    const { createFileStore } = await import('./server/report-store.js');

    const { dataset, issues } = loadGoldDataset(goldDir);
    if (!dataset) {
      console.error('Cannot load gold dataset:');
      for (const i of issues) console.error(`  - ${i.message}`);
      process.exit(1);
    }
    if (issues.length) {
      // Non-fatal issues (e.g. duplicate already filtered) — surface them.
      for (const i of issues) console.error(`warn: ${i.message}`);
    }

    const store: ReportStore = createFileStore(resolve(values['reports-dir'] as string));
    const report: Report | null = await store.get(reportId);
    if (!report) {
      console.error(`Report not found: ${reportId}`);
      process.exit(1);
    }

    const samples = Math.max(100, Number(values['bootstrap-samples']) || 1000);
    const seedVal = values.seed != null ? Number(values.seed) : undefined;
    const result = compareGoldToReport({
      report: report!,
      gold: dataset,
      variant: values.variant as string | undefined,
      samples,
      seed: Number.isFinite(seedVal) ? seedVal : undefined,
    });
    console.log(formatGoldCompare(result, dataset));
    return;
  }

  console.error(`Unknown subcommand: gold ${sub}. Use init / validate / compare.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// handleDebiasValidate — measure length-debias prompt sensitivity (Phase 3a)
// ---------------------------------------------------------------------------

async function handleDebiasValidate(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === '--help' || sub === '-h') {
    console.log([
      '',
      'Usage: omk bench debias-validate <kind> <reportId> [options]',
      '',
      'Kinds:',
      '  length    re-judge with the opposite length-debias setting and bootstrap CI',
      '            on the score diff. Cost ~doubles vs the original judge pass.',
      '',
      'Options:',
      '  --reports-dir <dir>          report store dir (default: ~/.oh-my-knowledge/reports)',
      '  --samples <path>             override samples file (default: from report.meta.request)',
      '  --variant <name>             which variant to validate (default: first)',
      '  --judge-executor <name>      executor for judge calls (default: claude)',
      '  --judge-model <model>        judge model id (default: from report)',
      '  --bootstrap-samples N        bootstrap iterations (default 1000)',
      '  --seed N                     deterministic CI seed',
      '',
    ].join('\n'));
    process.exit(sub ? 0 : 1);
  }

  if (sub !== 'length') {
    console.error(`Unknown debias-validate kind: ${sub}. Use "length".`);
    process.exit(1);
  }

  const reportId = rest[0];
  if (!reportId) {
    console.error('Usage: omk bench debias-validate length <reportId>');
    process.exit(1);
  }
  const { values } = parseArgs({
    args: rest.slice(1),
    options: {
      'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
      samples: { type: 'string' },
      variant: { type: 'string' },
      'judge-executor': { type: 'string', default: 'claude' },
      'judge-model': { type: 'string' },
      'bootstrap-samples': { type: 'string', default: '1000' },
      seed: { type: 'string' },
    },
    strict: false,
  });

  const { createFileStore } = await import('./server/report-store.js');
  const store: ReportStore = createFileStore(resolve(values['reports-dir'] as string));
  const report: Report | null = await store.get(reportId);
  if (!report) {
    console.error(`Report not found: ${reportId}`);
    process.exit(1);
  }

  // Resolve samples path: --samples overrides; otherwise read from report.meta.request.
  const samplesPath = (values.samples as string | undefined)
    ?? report!.meta?.request?.samplesPath;
  if (!samplesPath) {
    console.error('Cannot find samples path. Pass --samples <path> or ensure report has request.samplesPath.');
    process.exit(1);
  }
  const { loadSamples } = await import('./inputs/load-samples.js');
  const { samples } = loadSamples(samplesPath);

  const judgeModel = (values['judge-model'] as string | undefined)
    ?? report!.meta?.judgeModel;
  if (!judgeModel) {
    console.error('No judge model. Pass --judge-model <id> or ensure report has meta.judgeModel.');
    process.exit(1);
  }

  process.stderr.write('\n⚠ debias-validate 会重判所有 (sample × variant),judge cost 大致翻倍。\n');

  const { createExecutor } = await import('./executors/index.js');
  const judgeExecutor = createExecutor(values['judge-executor'] as string);
  const { validateLengthDebias, formatDebiasValidate } = await import('./grading/debias-validate.js');

  const seedVal = values.seed != null ? Number(values.seed) : undefined;
  const bsRaw = Number(values['bootstrap-samples']) || 1000;
  const result = await validateLengthDebias({
    report: report!,
    samples,
    judgeExecutor,
    judgeModel,
    variant: values.variant as string | undefined,
    bootstrapSamples: Math.max(100, bsRaw),
    seed: Number.isFinite(seedVal) ? seedVal : undefined,
    onProgress: ({ sample_id, completed, total }) => {
      process.stderr.write(`  judging ${completed}/${total}: ${sample_id}\n`);
    },
  });
  console.log(formatDebiasValidate(result));
}

// ---------------------------------------------------------------------------
// handleSaturation — re-compute saturation verdict from a finished report
// ---------------------------------------------------------------------------

async function handleSaturation(argv: string[]): Promise<void> {
  const reportId = argv[0];
  if (!reportId || reportId === '--help' || reportId === '-h') {
    console.log([
      '',
      'Usage: omk bench saturation <reportId> [options]',
      '',
      '回答"我跑够样本了吗?"。重新对已有 report 算饱和判定,无需重跑评测。',
      '',
      'Options:',
      '  --reports-dir <dir>   report store dir (default: ~/.oh-my-knowledge/reports)',
      '  --variant <name>      只算一个 variant (default: all)',
      '  --method <m>          slope | bootstrap-ci-width (default) | plateau-height',
      '  --threshold <num>     方法相关阈值 (默认随 method 选)',
      '  --window <num>        连续多少窗口满足才判饱和 (default 3)',
      '',
    ].join('\n'));
    process.exit(reportId ? 0 : 1);
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
      variant: { type: 'string' },
      method: { type: 'string', default: 'bootstrap-ci-width' },
      threshold: { type: 'string' },
      window: { type: 'string', default: '3' },
    },
    strict: false,
  });

  const { createFileStore } = await import('./server/report-store.js');
  const store: ReportStore = createFileStore(resolve(values['reports-dir'] as string));
  const report: Report | null = await store.get(reportId);
  if (!report) {
    console.error(`Report not found: ${reportId}`);
    process.exit(1);
  }

  const saturation = report!.variance?.saturation;
  if (!saturation) {
    console.error('该 report 无 saturation 数据 (需要 --repeat ≥ 2 才会记录)。');
    process.exit(1);
  }

  // Reconstruct cumulative score arrays from per-variant trace counts.
  // Since persisted shape stores (mean, ciLow, ciHigh) per checkpoint, not
  // raw scores, we can only re-run findSaturationPoint when raw scores are
  // reconstructable. For now, walk the report.results to rebuild.
  const variants = report!.meta.variants ?? [];
  const targetVariants = values.variant ? [values.variant as string] : variants;

  const method = values.method as 'slope' | 'bootstrap-ci-width' | 'plateau-height';
  if (!['slope', 'bootstrap-ci-width', 'plateau-height'].includes(method)) {
    console.error(`unknown method: ${method}`);
    process.exit(1);
  }
  const thresholdRaw = values.threshold != null ? Number(values.threshold) : undefined;
  const windowSize = Math.max(1, Number(values.window) || 3);

  // Per-variant: collect all composite scores in order from report.results.
  // Each report represents the LATEST run only. We use the saturation trace's
  // count series as the partition signal — checkpointSampleCounts[i] tells us
  // how many samples were cumulative after run i. We can't reconstruct
  // per-run boundaries from a single report, so this CLI mostly re-applies
  // the saved trace's metric. Future work: persist raw scores for full
  // re-computation.
  console.log(`\n  Saturation 重算 (method=${method}${thresholdRaw != null ? `, threshold=${thresholdRaw}` : ''})\n`);
  for (const variant of targetVariants) {
    const trace = saturation.perVariant[variant];
    if (!trace || trace.length === 0) {
      console.log(`  ${variant}: 无 trace 数据`);
      continue;
    }
    console.log(`  ${variant}:`);
    console.log(`    checkpoints: ${trace.length} (N=${trace.map((p) => p.n).join(', ')})`);
    console.log(`    最近一点 mean=${trace[trace.length - 1].mean.toFixed(3)}, CI=[${trace[trace.length - 1].ciLow.toFixed(3)}, ${trace[trace.length - 1].ciHigh.toFixed(3)}]`);
    if (saturation.verdicts?.[variant]) {
      const v = saturation.verdicts[variant];
      console.log(`    持久化判定 (${v.method}): ${v.saturated ? `已饱和@N=${v.atN}` : '未饱和'} - ${v.reason}`);
    } else if (trace.length < 5) {
      console.log(`    判定: 数据点 ${trace.length} < 5,跳过 (跑 --repeat 5 以上才输出)`);
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// handleVerdict — one-line ship/no-ship verdict (v0.22)
// ---------------------------------------------------------------------------

async function handleVerdict(argv: string[]): Promise<void> {
  const reportId = argv[0];
  if (!reportId || reportId === '--help' || reportId === '-h') {
    console.log([
      '',
      'Usage: omk bench verdict <reportId> [options]',
      '',
      '聚合 bootstrap CI / 三层 ci-gate / saturation / human α 给出一行结论。',
      '',
      'Verdict 等级:',
      '  PROGRESS      显著改进 + 三层全过',
      '  CAUTIOUS      改进真实但有警告 (gate 破 / 幅度太小 / 控制组本身崩)',
      '  REGRESS       显著回退 — 不要 ship',
      '  NOISE         CI 跨 0,无法判定',
      '  UNDERPOWERED  样本不足,需要扩 N 重测',
      '  SOLO          单变体报告,无对比对象',
      '',
      'Options:',
      '  --reports-dir <dir>      report store dir (default: ~/.oh-my-knowledge/reports)',
      '  --threshold <num>        三层 gate 阈值 (default 3.5,匹配 omk bench ci)',
      '  --trivial-diff <num>     "幅度太小"阈值 (default 0.1)',
      '  --verbose                展开 per-pair 详情',
      '',
    ].join('\n'));
    process.exit(reportId ? 0 : 1);
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
      threshold: { type: 'string' },
      'trivial-diff': { type: 'string' },
      verbose: { type: 'boolean', default: false },
    },
    strict: false,
  });

  const { createFileStore } = await import('./server/report-store.js');
  const store: ReportStore = createFileStore(resolve(values['reports-dir'] as string));
  const report: Report | null = await store.get(reportId);
  if (!report) {
    console.error(`Report not found: ${reportId}`);
    process.exit(1);
  }

  const { computeVerdict, formatVerdictText } = await import('./eval-core/verdict.js');
  const result = computeVerdict(report!, {
    ciThreshold: values.threshold != null ? Number(values.threshold) : undefined,
    triviallySmallDiff: values['trivial-diff'] != null ? Number(values['trivial-diff']) : undefined,
  });
  console.log(formatVerdictText(result, { verbose: Boolean(values.verbose) }));

  // Exit code reflects ship recommendation: 0 only on PROGRESS / SOLO-pass.
  // NOISE / UNDERPOWERED / CAUTIOUS / REGRESS all exit 1 so this composes
  // with shell `&&` chains in CI.
  if (result.level === 'PROGRESS') {
    process.exit(0);
  }
  if (result.level === 'SOLO' && result.headline.includes('PASS')) {
    process.exit(0);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// handleDiagnose — per-sample quality diagnostics (v0.23 A)
// ---------------------------------------------------------------------------

async function handleDiagnose(argv: string[]): Promise<void> {
  const reportId = argv[0];
  if (!reportId || reportId === '--help' || reportId === '-h') {
    console.log([
      '',
      'Usage: omk bench diagnose <reportId> [options]',
      '',
      '诊断样本集本身的质量问题:区分度低 / 重复 / 歧义 / 成本异常 / 全 fail。',
      '回答"测评结论是否被坏样本污染"——与 omk bench verdict 互补。',
      '',
      'Options:',
      '  --reports-dir <dir>      report store dir',
      '  --samples <path>         样本文件路径 (用于 near-duplicate 检测;默认从 report.meta.request 读)',
      '  --top <n>                每类只显示前 N 个 (默认 10,0=全部)',
      '  --duplicate-rouge <num>  near-duplicate ROUGE-1 阈值 (默认 0.7)',
      '  --ambiguous-stddev <num> 歧义阈值,judge stddev (默认 1.0,需要 --judge-repeat ≥ 2 数据)',
      '  --cost-k <num>           成本异常倍数 vs median (默认 3)',
      '  --latency-k <num>        耗时异常倍数 vs median (默认 3)',
      '  --flat <num>             flat_scores 分差阈值 (默认 0.5)',
      '',
    ].join('\n'));
    process.exit(reportId ? 0 : 1);
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
      samples: { type: 'string' },
      top: { type: 'string', default: '10' },
      'duplicate-rouge': { type: 'string' },
      'ambiguous-stddev': { type: 'string' },
      'cost-k': { type: 'string' },
      'latency-k': { type: 'string' },
      flat: { type: 'string' },
    },
    strict: false,
  });

  const { createFileStore } = await import('./server/report-store.js');
  const store: ReportStore = createFileStore(resolve(values['reports-dir'] as string));
  const report: Report | null = await store.get(reportId);
  if (!report) {
    console.error(`Report not found: ${reportId}`);
    process.exit(1);
  }

  // Try to read the samples file for near-duplicate detection. Source order:
  //  1. --samples <path> override
  //  2. report.meta.request.samplesPath (recorded at run time)
  // If neither resolves to a readable file, skip near-duplicate gracefully.
  let samples: import('./types.js').Sample[] | undefined;
  const samplesPath = (values.samples as string | undefined) ?? report!.meta?.request?.samplesPath;
  if (samplesPath && existsSync(samplesPath)) {
    try {
      const { loadSamples } = await import('./inputs/load-samples.js');
      samples = loadSamples(samplesPath).samples;
    } catch (err) {
      process.stderr.write(`warn: 加载 samples 文件失败 (${samplesPath}): ${(err as Error).message}\n`);
    }
  }

  const topRaw = Number(values.top);
  const topN = Number.isFinite(topRaw) && topRaw > 0 ? topRaw : undefined;

  const { diagnoseSamples, formatSampleDiagnostics } = await import('./analysis/sample-diagnostics.js');
  const diag = diagnoseSamples(report!, {
    samples,
    duplicateRouge: values['duplicate-rouge'] != null ? Number(values['duplicate-rouge']) : undefined,
    ambiguousStddev: values['ambiguous-stddev'] != null ? Number(values['ambiguous-stddev']) : undefined,
    costOutlierK: values['cost-k'] != null ? Number(values['cost-k']) : undefined,
    latencyOutlierK: values['latency-k'] != null ? Number(values['latency-k']) : undefined,
    flatThreshold: values.flat != null ? Number(values.flat) : undefined,
  });
  console.log(formatSampleDiagnostics(diag, { topN }));

  // Exit code: 0 if health ≥ 70 and no errors; 1 otherwise. CI-friendly.
  if (diag.totals.errors === 0 && diag.healthScore >= 70) {
    process.exit(0);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// handleFailures — LLM-driven failure clustering (v0.23 B)
// ---------------------------------------------------------------------------

async function handleFailures(argv: string[]): Promise<void> {
  const reportId = argv[0];
  if (!reportId || reportId === '--help' || reportId === '-h') {
    console.log([
      '',
      'Usage: omk bench failures <reportId> [options]',
      '',
      '把已有 report 的失败样本喂给一次 LLM 调用,自动聚类 + 给修复建议。',
      '失败定义:compositeScore < threshold 或 ok=false。',
      '',
      'Options:',
      '  --reports-dir <dir>      report store dir',
      '  --judge-executor <name>  执行器 (default: claude)',
      '  --judge-model <id>       聚类用的 model (default: 沿用 report.meta.judgeModel)',
      '  --max-clusters <n>       最多多少 cluster (default 5)',
      '  --threshold <num>        compositeScore < threshold 算失败 (default 3)',
      '  --max-feed <n>           最多喂给 LLM 多少条 (default 50,超出取最差)',
      '',
    ].join('\n'));
    process.exit(reportId ? 0 : 1);
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
      'judge-executor': { type: 'string', default: 'claude' },
      'judge-model': { type: 'string' },
      'max-clusters': { type: 'string', default: '5' },
      threshold: { type: 'string', default: '3' },
      'max-feed': { type: 'string', default: '50' },
    },
    strict: false,
  });

  const { createFileStore } = await import('./server/report-store.js');
  const store: ReportStore = createFileStore(resolve(values['reports-dir'] as string));
  const report: Report | null = await store.get(reportId);
  if (!report) {
    console.error(`Report not found: ${reportId}`);
    process.exit(1);
  }

  const judgeModel = (values['judge-model'] as string | undefined) ?? report!.meta?.judgeModel;
  if (!judgeModel) {
    console.error('No judge model. Pass --judge-model <id> or ensure report has meta.judgeModel.');
    process.exit(1);
  }

  const { createExecutor } = await import('./executors/index.js');
  const executor = createExecutor(values['judge-executor'] as string);
  const { clusterFailures, formatFailureClusterReport } = await import('./analysis/failure-clusterer.js');

  const out = await clusterFailures({
    report: report!,
    executor,
    judgeModel,
    maxClusters: Number(values['max-clusters']) || 5,
    failureThreshold: Number(values.threshold) || 3,
    maxFailuresFed: Number(values['max-feed']) || 50,
  });
  console.log(formatFailureClusterReport(out));
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

main();
