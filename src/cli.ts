#!/usr/bin/env node

import { parseArgs, type ParseArgsConfig } from 'node:util';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { discoverVariants } from './inputs/skill-loader.js';
import type {
  Report,
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
  variants: string[];
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

// Shared CLI options for run/ci commands
const RUN_OPTIONS: ParseArgsConfig['options'] = {
  samples: { type: 'string', default: 'eval-samples.json' },
  'skill-dir': { type: 'string', default: 'skills' },
  variants: { type: 'string' },
  model: { type: 'string', default: 'sonnet' },
  'judge-model': { type: 'string', default: 'haiku' },
  'output-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
  'no-judge': { type: 'boolean', default: false },
  'no-cache': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  concurrency: { type: 'string', default: '1' },
  timeout: { type: 'string', default: '120' },
  executor: { type: 'string', default: 'claude' },
  'judge-executor': { type: 'string' },
  each: { type: 'boolean', default: false },
  'skip-preflight': { type: 'boolean', default: false },
  'mcp-config': { type: 'string' },
  'no-serve': { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
  retry: { type: 'string', default: '0' },
  resume: { type: 'string' },
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

  let samplesFile: string = (values.samples as string) ?? 'eval-samples.json';
  if (samplesFile === 'eval-samples.json' && !existsSync(resolve(samplesFile))) {
    if (existsSync(resolve('eval-samples.yaml'))) samplesFile = 'eval-samples.yaml';
    else if (existsSync(resolve('eval-samples.yml'))) samplesFile = 'eval-samples.yml';
  }

  const skillDir: string = resolve(values['skill-dir'] as string);
  const variants: string[] = values.variants
    ? (values.variants as string).split(',').map((v: string) => v.trim()).filter(Boolean)
    : discoverVariants(skillDir);

  return {
    values,
    config: {
      samplesPath: resolve(samplesFile),
      skillDir,
      variants,
      model: values.model as string | undefined,
      judgeModel: values['judge-model'] as string | undefined,
      outputDir: resolve(values['output-dir'] as string),
      noJudge: values['no-judge'] as boolean | undefined,
      noCache: values['no-cache'] as boolean | undefined,
      dryRun: values['dry-run'] as boolean | undefined,
      concurrency: Math.max(1, Number(values.concurrency) || 1),
      timeoutMs: Math.max(1, Number(values.timeout) || 120) * 1000,
      executorName: values.executor as string | undefined,
      judgeExecutorName: (values['judge-executor'] || values.executor) as string | undefined,
      skipPreflight: values['skip-preflight'] as boolean | undefined,
      mcpConfig: values['mcp-config'] as string | undefined,
      verbose: values.verbose as boolean | undefined,
      retry: Math.max(0, Number(values.retry) || 0),
      resume: values.resume as string | undefined,
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

Options for "bench run":

  --samples <path>       Sample file (default: eval-samples.json)
  --skill-dir <path>     Skill definitions directory (default: skills)
  --variants <v1,v2>     Comma-separated variant expressions (auto-detected from skill-dir)
                         Each variant resolves to an artifact and optional runtime context
                         Use "baseline" for baseline artifact comparison
                         Use "git:name" to load artifact from last commit
                         Use "git:ref:name" to load from specific commit
                         Use path with "/" to load artifact from file directly
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

Options for "bench ci":
  (same as "bench run", plus:)
  --threshold <number>   Minimum composite score to pass (default: 3.5)

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
  omk bench run --variants v1,v2
  omk bench run --variants baseline,my-skill
  omk bench run --variants git:my-skill,my-skill
  omk bench run --variants ./old-skill.md,./new-skill.md
  omk bench run --each
  omk bench run --dry-run
  omk bench report --port 8080
  omk bench report --export v1-vs-v2-20260326-1832
  omk bench init my-eval
  omk bench gen-samples skills/my-skill.md
  omk bench gen-samples --each
  omk bench diff <report-id-1> <report-id-2>
  omk bench evolve skills/my-skill.md --rounds 5
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

  if (domain !== 'bench') {
    console.error(`Unknown domain: ${domain}. Use "omk bench <command>".`);
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

        if (!values['no-serve']) {
          const { createReportServer } = await import('./server/report-server.js');
          const server: ReportServer = createReportServer({ reportsDir: resolve(values['output-dir'] as string) });
          const serverUrl: string = await server.start();
          const reportUrl: string = `${serverUrl}/run/${report.id}`;
          process.stderr.write(`\n📊 Report server running at ${serverUrl}\n`);
          process.stderr.write(`👉 View report: ${reportUrl}\n`);
          process.stderr.write('\nPress Ctrl+C to stop the server\n');

          const { platform } = await import('node:os');
          const openCmd: string = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
          const { execFile: execFileCb } = await import('node:child_process');
          execFileCb(openCmd, [reportUrl], () => { });
        }
      }
      return;
    }

    const repeatCount: number = Math.max(1, Number(values.repeat) || 1);
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

      if (!values['no-serve']) {
        // Auto-start report server
        const { createReportServer } = await import('./server/report-server.js');
        const server: ReportServer = createReportServer({
          reportsDir: resolve(values['output-dir'] as string),
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
  console.log('  3. Run: omk bench run --variants v1,v2');
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
    let allPass: boolean = true;

    if ((report as Report & { dryRun?: boolean }).dryRun) {
      console.log('CI dry-run: no scores to check');
      process.exit(0);
    }

    for (const [variant, stats] of Object.entries(report.summary || {})) {
      const score: number = stats.avgCompositeScore ?? 0;
      const status: string = score >= threshold ? 'PASS' : 'FAIL';
      console.log(`${status}: ${variant} score=${score.toFixed(2)} threshold=${threshold}`);
      if (score < threshold) allPass = false;
    }

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
