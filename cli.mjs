#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_REPORTS_DIR = join(homedir(), '.oh-my-knowledge', 'reports');

const HELP = `
oh-my-knowledge — Knowledge artifact evaluation toolkit

Usage:
  omk bench run [options]     Run an evaluation
  omk bench report [options]  Start the report server
  omk bench ci [options]      Run evaluation and exit with pass/fail code
  omk bench init [dir]        Scaffold a new eval project

Options for "bench run":
  --samples <path>       Sample file (default: eval-samples.json)
  --skill-dir <path>     Skill definitions directory (default: skills)
  --variants <v1,v2>     Comma-separated variant names (default: v1,v2)
  --model <name>         Model under test (default: sonnet)
  --judge-model <name>   Judge model (default: haiku)
  --output-dir <path>    Report output directory (default: ~/.oh-my-knowledge/reports/)
  --no-judge             Skip LLM judging
  --dry-run              Preview tasks without executing
  --blind                Blind A/B mode: hide variant names in report
  --concurrency <n>      Number of parallel tasks (default: 1)
  --repeat <n>           Run evaluation N times for variance analysis (default: 1)
  --executor <name>      Executor to use (default: claude)

Options for "bench ci":
  (same as "bench run", plus:)
  --threshold <number>   Minimum composite score to pass (default: 3.5)

Options for "bench report":
  --port <number>        Server port (default: 7799)
  --reports-dir <path>   Reports directory (default: ~/.oh-my-knowledge/reports/)

Examples:
  omk bench run --variants v1,v2
  omk bench run --dry-run
  omk bench report --port 8080
  omk bench init my-eval
`.trim();

async function main() {
  const [domain, command, ...rest] = process.argv.slice(2);

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
    default:
      console.error(`Unknown command: bench ${command}. Use "run", "report", "ci", or "init".`);
      process.exit(1);
  }
}

async function handleRun(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      samples:       { type: 'string', default: 'eval-samples.json' },
      'skill-dir':   { type: 'string', default: 'skills' },
      variants:      { type: 'string', default: 'v1,v2' },
      model:         { type: 'string', default: 'sonnet' },
      'judge-model': { type: 'string', default: 'haiku' },
      'output-dir':  { type: 'string', default: DEFAULT_REPORTS_DIR },
      'no-judge':    { type: 'boolean', default: false },
      'dry-run':     { type: 'boolean', default: false },
      blind:         { type: 'boolean', default: false },
      concurrency:   { type: 'string', default: '1' },
      repeat:        { type: 'string', default: '1' },
      executor:      { type: 'string', default: 'claude' },
    },
    strict: false,
  });

  const { runEvaluation, runMultiple } = await import('./lib/runner.mjs');
  const { existsSync } = await import('node:fs');

  // Auto-detect YAML if default JSON not found
  let samplesFile = values.samples;
  if (samplesFile === 'eval-samples.json' && !existsSync(resolve(samplesFile))) {
    if (existsSync(resolve('eval-samples.yaml'))) samplesFile = 'eval-samples.yaml';
    else if (existsSync(resolve('eval-samples.yml'))) samplesFile = 'eval-samples.yml';
  }

  const config = {
    samplesPath: resolve(samplesFile),
    skillDir: resolve(values['skill-dir']),
    variants: values.variants.split(',').map((v) => v.trim()).filter(Boolean),
    model: values.model,
    judgeModel: values['judge-model'],
    outputDir: resolve(values['output-dir']),
    noJudge: values['no-judge'],
    dryRun: values['dry-run'],
    blind: values.blind,
    concurrency: Math.max(1, Number(values.concurrency) || 1),
    executorName: values.executor,
    onProgress({ phase, completed, total, sample_id, variant, durationMs, inputTokens, outputTokens, costUSD, score }) {
      if (phase === 'start') {
        process.stderr.write(`[${completed}/${total}] ${sample_id}/${variant} ...`);
      } else {
        const costInfo = costUSD > 0 ? ` $${costUSD.toFixed(4)}` : '';
        const scoreInfo = typeof score === 'number' ? ` score=${score}` : '';
        process.stderr.write(` ${durationMs}ms ${inputTokens}+${outputTokens}tok${costInfo}${scoreInfo}\n`);
      }
    },
  };

  try {
    const repeatCount = Math.max(1, Number(values.repeat) || 1);
    let report, filePath;

    if (repeatCount > 1) {
      const result = await runMultiple({
        ...config,
        repeat: repeatCount,
        onRepeatProgress({ run, total }) {
          process.stderr.write(`\n=== Run ${run}/${total} ===\n`);
        },
      });
      report = result.report;
      filePath = null;
    } else {
      const result = await runEvaluation(config);
      report = result.report;
      filePath = result.filePath;
    }

    console.log(JSON.stringify(report, null, 2));
    if (filePath) {
      process.stderr.write(`\nReport saved to: ${filePath}\n`);

      // Auto-start report server
      const { createReportServer } = await import('./lib/report-server.mjs');
      const server = createReportServer({
        reportsDir: resolve(values['output-dir']),
      });
      const serverUrl = await server.start();
      const reportUrl = `${serverUrl}/run/${report.id}`;
      process.stderr.write(`Report server running at ${serverUrl}\n`);
      process.stderr.write(`View report: ${reportUrl}\n`);
      process.stderr.write('Press Ctrl+C to stop\n');
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function handleReport(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port:          { type: 'string', default: '7799' },
      'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
    },
    strict: false,
  });

  const { createReportServer } = await import('./lib/report-server.mjs');
  const server = createReportServer({
    port: Number(values.port),
    reportsDir: resolve(values['reports-dir']),
  });

  const url = await server.start();
  console.log(`Report server running at ${url}`);
  console.log('Press Ctrl+C to stop');
}

async function handleInit(argv) {
  const targetDir = resolve(argv[0] || '.');

  const { cpSync, existsSync, mkdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname } = await import('node:path');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const examplesDir = join(__dirname, 'examples', 'code-review');

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  cpSync(examplesDir, targetDir, { recursive: true });
  console.log(`Eval project scaffolded at: ${targetDir}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Edit eval-samples.json to add your test cases');
  console.log('  2. Edit skills/v1.md and skills/v2.md with your skill versions');
  console.log('  3. Run: omk bench run --variants v1,v2');
}

async function handleCi(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      samples:       { type: 'string', default: 'eval-samples.json' },
      'skill-dir':   { type: 'string', default: 'skills' },
      variants:      { type: 'string', default: 'v1,v2' },
      model:         { type: 'string', default: 'sonnet' },
      'judge-model': { type: 'string', default: 'haiku' },
      'output-dir':  { type: 'string', default: DEFAULT_REPORTS_DIR },
      'no-judge':    { type: 'boolean', default: false },
      'dry-run':     { type: 'boolean', default: false },
      concurrency:   { type: 'string', default: '1' },
      executor:      { type: 'string', default: 'claude' },
      threshold:     { type: 'string', default: '3.5' },
    },
    strict: false,
  });

  const { runEvaluation } = await import('./lib/runner.mjs');
  const { existsSync } = await import('node:fs');

  let samplesFile = values.samples;
  if (samplesFile === 'eval-samples.json' && !existsSync(resolve(samplesFile))) {
    if (existsSync(resolve('eval-samples.yaml'))) samplesFile = 'eval-samples.yaml';
    else if (existsSync(resolve('eval-samples.yml'))) samplesFile = 'eval-samples.yml';
  }

  const variantList = values.variants.split(',').map((v) => v.trim()).filter(Boolean);

  try {
    const { report } = await runEvaluation({
      samplesPath: resolve(samplesFile),
      skillDir: resolve(values['skill-dir']),
      variants: variantList,
      model: values.model,
      judgeModel: values['judge-model'],
      outputDir: resolve(values['output-dir']),
      noJudge: values['no-judge'],
      dryRun: values['dry-run'],
      concurrency: Math.max(1, Number(values.concurrency) || 1),
      executorName: values.executor,
      onProgress({ phase, completed, total, sample_id, variant }) {
        if (phase === 'start') {
          process.stderr.write(`[${completed}/${total}] ${sample_id}/${variant} ...\n`);
        }
      },
    });

    const threshold = Number(values.threshold);
    let allPass = true;

    if (report.dryRun) {
      console.log('CI dry-run: no scores to check');
      process.exit(0);
    }

    for (const [variant, stats] of Object.entries(report.summary || {})) {
      const score = stats.avgCompositeScore ?? 0;
      const status = score >= threshold ? 'PASS' : 'FAIL';
      console.log(`${status}: ${variant} score=${score.toFixed(2)} threshold=${threshold}`);
      if (score < threshold) allPass = false;
    }

    process.exit(allPass ? 0 : 1);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
