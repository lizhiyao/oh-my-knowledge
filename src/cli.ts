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
  } else {
    const discovered = discoverVariants(skillDir);
    const hint = discovered.length > 0 ? `\n  skill-dir (${skillDir}) 下发现的候选：${discovered.join(', ')}` : '';
    throw new Error(
      `请通过 --control / --treatment 或 --config eval.yaml 声明 variant 角色。\n`
      + `  示例：omk bench run --control baseline --treatment my-skill${hint}\n`
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
    default:
      console.error(`Unknown command: bench ${command}. Use "run", "report", "ci", "init", "gen-samples", or "evolve".`);
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
  });

  const { runEvaluation, runMultiple, runEachEvaluation } = await import('./eval-workflows/run-evaluation.js');

  config.blind = values.blind as boolean | undefined;
  config.onProgress = defaultOnProgress as unknown as ProgressCallback;

  try {
    // --each mode: evaluate each skill independently
    if (values.each) {
      const { report, filePath } = await runEachEvaluation({
        ...config,
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

    // --repeat 诚实输入校验:非 ≥1 整数时提示并钳到 1,不静默掩盖用户错字/极端输入
    const repeatRaw = values.repeat as string | undefined;
    const parsedRepeat = repeatRaw !== undefined ? Number(repeatRaw) : 1;
    if (repeatRaw !== undefined && (!Number.isFinite(parsedRepeat) || parsedRepeat < 1)) {
      process.stderr.write(`⚠ --repeat "${repeatRaw}" 无效(期望 ≥ 1 的整数),已按 1 次评测执行\n`);
    }
    const repeatCount: number = Math.max(1, Math.floor(parsedRepeat) || 1);
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
  const { computeSkillHealthReport } = await import('./observability/production-analyzer.js');
  const report = computeSkillHealthReport(tracePath, {
    kbRoot: values.kb ? resolve(values.kb) : undefined,
    from,
    to,
    skills,
  });

  const { renderSkillHealthReport } = await import('./renderer/skill-health-renderer.js');
  const html = renderSkillHealthReport(report);

  const outDir = resolve(values['output-dir'] || join(process.env.HOME || '.', '.oh-my-knowledge', 'analyses'));
  mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = join(outDir, `${timestamp}-skill-health.html`);
  writeFileSync(outPath, html);

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
  console.log(`report written to: ${outPath}`);
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
  if (argv.length < 2) {
    console.error('Usage: omk bench diff <report-id-1> <report-id-2>');
    process.exit(1);
  }

  const { createFileStore } = await import('./server/report-store.js');
  const store: ReportStore = createFileStore(resolve(DEFAULT_REPORTS_DIR));

  const [id1, id2]: string[] = argv;
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

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

main();
