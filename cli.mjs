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
  --executor <name>      Executor to use (default: claude)

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
    default:
      console.error(`Unknown command: bench ${command}. Use "run", "report", or "init".`);
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
      executor:      { type: 'string', default: 'claude' },
    },
    strict: false,
  });

  const { runEvaluation } = await import('./lib/runner.mjs');

  const config = {
    samplesPath: resolve(values.samples),
    skillDir: resolve(values['skill-dir']),
    variants: values.variants.split(',').map((v) => v.trim()).filter(Boolean),
    model: values.model,
    judgeModel: values['judge-model'],
    outputDir: resolve(values['output-dir']),
    noJudge: values['no-judge'],
    dryRun: values['dry-run'],
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
    const { report, filePath } = await runEvaluation(config);
    console.log(JSON.stringify(report, null, 2));
    if (filePath) {
      process.stderr.write(`\nReport saved to: ${filePath}\n`);
      process.stderr.write(`View at: http://127.0.0.1:${values.port || 7799}/run/${report.id}\n`);
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

  await server.start();
  console.log(`Report server running at http://127.0.0.1:${values.port}`);
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

main();
