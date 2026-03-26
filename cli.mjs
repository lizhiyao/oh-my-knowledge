#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { discoverVariants } from './lib/runner.mjs';

const DEFAULT_REPORTS_DIR = join(homedir(), '.oh-my-knowledge', 'reports');

// Shared CLI options for run/ci commands
const RUN_OPTIONS = {
  samples:       { type: 'string', default: 'eval-samples.json' },
  'skill-dir':   { type: 'string', default: 'skills' },
  variants:      { type: 'string' },
  model:         { type: 'string', default: 'sonnet' },
  'judge-model': { type: 'string', default: 'haiku' },
  'output-dir':  { type: 'string', default: DEFAULT_REPORTS_DIR },
  'no-judge':    { type: 'boolean', default: false },
  'dry-run':     { type: 'boolean', default: false },
  concurrency:   { type: 'string', default: '1' },
  executor:      { type: 'string', default: 'claude' },
  each:          { type: 'boolean', default: false },
};

function parseRunConfig(argv, extraOptions = {}) {
  const { values } = parseArgs({
    args: argv,
    options: { ...RUN_OPTIONS, ...extraOptions },
    strict: false,
  });

  let samplesFile = values.samples;
  if (samplesFile === 'eval-samples.json' && !existsSync(resolve(samplesFile))) {
    if (existsSync(resolve('eval-samples.yaml'))) samplesFile = 'eval-samples.yaml';
    else if (existsSync(resolve('eval-samples.yml'))) samplesFile = 'eval-samples.yml';
  }

  const skillDir = resolve(values['skill-dir']);
  const variants = values.variants
    ? values.variants.split(',').map((v) => v.trim()).filter(Boolean)
    : discoverVariants(skillDir);

  return {
    values,
    config: {
      samplesPath: resolve(samplesFile),
      skillDir,
      variants,
      model: values.model,
      judgeModel: values['judge-model'],
      outputDir: resolve(values['output-dir']),
      noJudge: values['no-judge'],
      dryRun: values['dry-run'],
      concurrency: Math.max(1, Number(values.concurrency) || 1),
      executorName: values.executor,
    },
  };
}

const HELP = `
oh-my-knowledge — Knowledge artifact evaluation toolkit

Usage:
  omk bench run [options]     Run an evaluation
  omk bench report [options]  Start the report server
  omk bench ci [options]      Run evaluation and exit with pass/fail code
  omk bench init [dir]        Scaffold a new eval project
  omk bench gen-samples [skill]  Generate eval-samples from skill content

Options for "bench run":

  --samples <path>       Sample file (default: eval-samples.json)
  --skill-dir <path>     Skill definitions directory (default: skills)
  --variants <v1,v2>     Comma-separated variant names (auto-detected from skill-dir)
                         Use "baseline" for no-skill comparison
                         Use "git:name" to load skill from last commit
                         Use "git:ref:name" to load from specific commit
                         Use path with "/" to load from file directly
  --model <name>         Model under test (default: sonnet)
  --judge-model <name>   Judge model (default: haiku)
  --output-dir <path>    Report output directory (default: ~/.oh-my-knowledge/reports/)
  --no-judge             Skip LLM judging
  --dry-run              Preview tasks without executing
  --blind                Blind A/B mode: hide variant names in report
  --concurrency <n>      Number of parallel tasks (default: 1)
  --repeat <n>           Run evaluation N times for variance analysis (default: 1)
  --executor <name>      Executor to use (default: claude)
  --each                 Evaluate each skill independently against baseline
                         Requires {name}.eval-samples.json paired with each skill

Options for "bench ci":
  (same as "bench run", plus:)
  --threshold <number>   Minimum composite score to pass (default: 3.5)

Options for "bench report":
  --port <number>        Server port (default: 7799)
  --reports-dir <path>   Reports directory (default: ~/.oh-my-knowledge/reports/)
  --export <id>          Export report as standalone HTML file

Options for "bench gen-samples":
  --each                 Generate for all skills missing eval-samples
  --count <n>            Number of samples to generate per skill (default: 5)
  --model <name>         Model for generation (default: sonnet)
  --skill-dir <path>     Skill directory (default: skills), used with --each

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
    case 'gen-samples':
      await handleGenSamples(rest);
      break;
    default:
      console.error(`Unknown command: bench ${command}. Use "run", "report", "ci", "init", or "gen-samples".`);
      process.exit(1);
  }
}

function defaultOnProgress({ phase, completed, total, sample_id, variant, durationMs, inputTokens, outputTokens, costUSD, score }) {
  if (phase === 'start') {
    process.stderr.write(`[${completed}/${total}] ${sample_id}/${variant} ⏳ 执行中...\n`);
  } else {
    const costInfo = costUSD > 0 ? ` $${costUSD.toFixed(4)}` : '';
    const scoreInfo = typeof score === 'number' ? ` score=${score}` : '';
    process.stderr.write(`[${completed}/${total}] ${sample_id}/${variant} ✓ ${durationMs}ms ${inputTokens}+${outputTokens} tokens${costInfo}${scoreInfo}\n`);
  }
}

async function handleRun(argv) {
  const { values, config } = parseRunConfig(argv, {
    blind:  { type: 'boolean', default: false },
    repeat: { type: 'string', default: '1' },
  });

  const { runEvaluation, runMultiple, runEachEvaluation } = await import('./lib/runner.mjs');

  config.blind = values.blind;
  config.onProgress = defaultOnProgress;

  try {
    // --each mode: evaluate each skill independently
    if (values.each) {
      const { report, filePath } = await runEachEvaluation({
        ...config,
        onSkillProgress({ phase, skill, current, total }) {
          if (phase === 'start') {
            process.stderr.write(`\n=== [${current}/${total}] Skill: ${skill} ===\n`);
          }
        },
      });
      console.log(JSON.stringify(report, null, 2));
      if (filePath) {
        process.stderr.write('\n✅ 批量评测完成\n');
        process.stderr.write(`📄 Report saved to: ${filePath}\n`);

        const { createReportServer } = await import('./lib/report-server.mjs');
        const server = createReportServer({ reportsDir: resolve(values['output-dir']) });
        const serverUrl = await server.start();
        const reportUrl = `${serverUrl}/run/${report.id}`;
        process.stderr.write(`\n📊 Report server running at ${serverUrl}\n`);
        process.stderr.write(`👉 View report: ${reportUrl}\n`);
        process.stderr.write('\nPress Ctrl+C to stop the server\n');

        const { platform } = await import('node:os');
        const openCmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
        const { execFile: execFileCb } = await import('node:child_process');
        execFileCb(openCmd, [reportUrl], () => {});
      }
      return;
    }

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
      process.stderr.write('\n✅ 评测完成\n');
      process.stderr.write(`📄 Report saved to: ${filePath}\n`);

      // Auto-start report server
      const { createReportServer } = await import('./lib/report-server.mjs');
      const server = createReportServer({
        reportsDir: resolve(values['output-dir']),
      });
      const serverUrl = await server.start();
      const reportUrl = `${serverUrl}/run/${report.id}`;
      process.stderr.write(`\n📊 Report server running at ${serverUrl}\n`);
      process.stderr.write(`👉 View report: ${reportUrl}\n`);
      process.stderr.write('\nPress Ctrl+C to stop the server\n');

      // Auto-open report in browser
      const { platform } = await import('node:os');
      const openCmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
      const { execFile: execFileCb } = await import('node:child_process');
      execFileCb(openCmd, [reportUrl], () => {});
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
      export:        { type: 'string' },
    },
    strict: false,
  });

  if (values.export) {
    const { createFileStore } = await import('./lib/report-store.mjs');
    const { renderRunDetail, renderEachRunDetail } = await import('./lib/html-renderer.mjs');
    const { writeFileSync } = await import('node:fs');
    const store = createFileStore(resolve(values['reports-dir']));
    const report = await store.get(values.export);
    if (!report) {
      console.error(`Report not found: ${values.export}`);
      process.exit(1);
    }
    const html = report.each ? renderEachRunDetail(report) : renderRunDetail(report);
    const outPath = resolve(`${values.export}.html`);
    writeFileSync(outPath, html);
    console.log(`Exported to: ${outPath}`);
    console.log('Open in browser, or Ctrl+P to save as PDF');
    return;
  }

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

  const { cpSync, mkdirSync } = await import('node:fs');
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

async function handleGenSamples(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      each:        { type: 'boolean', default: false },
      count:       { type: 'string', default: '5' },
      model:       { type: 'string', default: 'sonnet' },
      'skill-dir': { type: 'string', default: 'skills' },
    },
    strict: false,
    allowPositionals: true,
  });

  const { generateSamples } = await import('./lib/generator.mjs');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const count = Math.max(1, Number(values.count) || 5);
  const model = values.model;

  if (values.each) {
    // Batch mode: generate for all skills missing eval-samples
    const { discoverVariants } = await import('./lib/runner.mjs');
    const skillDir = resolve(values['skill-dir']);
    if (!existsSync(skillDir)) {
      console.error(`Skill directory not found: ${skillDir}`);
      process.exit(1);
    }

    const { readdirSync, statSync } = await import('node:fs');
    const entries = readdirSync(skillDir);
    let generated = 0;

    for (const entry of entries) {
      let name, skillPath, samplesPath;
      const fullPath = join(skillDir, entry);

      if (entry.endsWith('.md') && !entry.endsWith('.eval-samples.json')) {
        name = entry.slice(0, -3);
        skillPath = fullPath;
        samplesPath = join(skillDir, `${name}.eval-samples.json`);
      } else if (statSync(fullPath).isDirectory()) {
        const skillMd = join(fullPath, 'SKILL.md');
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
        const skillContent = readFileSync(skillPath, 'utf-8');
        const { samples, costUSD } = await generateSamples({ skillContent, count, model });
        writeFileSync(samplesPath, JSON.stringify(samples, null, 2));
        process.stderr.write(`✅ ${name}: 已生成 ${samples.length} 个样本 → ${samplesPath} (${costUSD > 0 ? `$${costUSD.toFixed(4)}` : ''})\n`);
        generated++;
      } catch (err) {
        process.stderr.write(`❌ ${name}: ${err.message}\n`);
      }
    }

    if (generated === 0) {
      console.log('没有需要生成的 eval-samples（所有 skill 已有配对文件）');
    } else {
      console.log(`\n共生成 ${generated} 份 eval-samples，请审查后运行: omk bench run --each`);
    }
  } else {
    // Single skill mode
    const skillPath = argv.find((a) => !a.startsWith('-'));
    if (!skillPath) {
      console.error('请指定 skill 文件路径，例如: omk bench gen-samples skills/my-skill.md');
      process.exit(1);
    }

    const resolvedPath = resolve(skillPath);
    if (!existsSync(resolvedPath)) {
      console.error(`Skill file not found: ${resolvedPath}`);
      process.exit(1);
    }

    const skillContent = readFileSync(resolvedPath, 'utf-8');
    const outputPath = resolve('eval-samples.json');

    if (existsSync(outputPath)) {
      console.error(`eval-samples.json 已存在。如需覆盖请先删除。`);
      process.exit(1);
    }

    process.stderr.write(`🔄 正在生成 ${count} 个测试样本...\n`);
    try {
      const { samples, costUSD } = await generateSamples({ skillContent, count, model });
      writeFileSync(outputPath, JSON.stringify(samples, null, 2));
      process.stderr.write(`✅ 已生成 ${samples.length} 个样本 → ${outputPath} (${costUSD > 0 ? `$${costUSD.toFixed(4)}` : ''})\n`);
      console.log('\n请审查生成的测试样本后运行: omk bench run');
    } catch (err) {
      console.error(`生成失败: ${err.message}`);
      process.exit(1);
    }
  }
}

async function handleCi(argv) {
  const { values, config } = parseRunConfig(argv, {
    threshold: { type: 'string', default: '3.5' },
  });

  const { runEvaluation } = await import('./lib/runner.mjs');

  config.onProgress = defaultOnProgress;

  try {
    const { report } = await runEvaluation(config);

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
