import { CliExit } from '../cli-exit.js';
import { tCli, langFromArgv } from '../i18n.js';
import { parseRunConfig } from '../parse-run-config.js';
import { makeOnProgress } from '../progress.js';
import { computeRunTally } from '../run-tally.js';
import type { BatchEvaluationReport, EvaluationReport, Report, ProgressCallback } from '../../types/index.js';
import type { DryRunBatchReport, DryRunReport } from '../../eval-workflows/run-evaluation.js';
import type { EvalResult, ReportServer } from './_shared.js';

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

type ParsedValues = Record<string, string | boolean | undefined>;
type CliLang = 'zh' | 'en';

function isDryRunReport(report: unknown): report is DryRunReport {
  return Boolean(report && typeof report === 'object' && (report as { dryRun?: unknown }).dryRun === true);
}

function isDryRunBatchReport(report: unknown): report is DryRunBatchReport {
  return isDryRunReport(report) && (report as { batch?: unknown }).batch === true;
}

function verdictOptions(values: ParsedValues): { gateThreshold: number; triviallySmallDiff: number | undefined } {
  const rawThreshold = values.threshold as string | undefined;
  const gateThreshold = rawThreshold !== undefined && Number.isFinite(Number(rawThreshold))
    ? Number(rawThreshold)
    : 3.5;
  const rawTrivial = values['trivial-diff'] as string | undefined;
  const triviallySmallDiff = rawTrivial !== undefined && Number.isFinite(Number(rawTrivial))
    ? Number(rawTrivial)
    : undefined;
  return { gateThreshold, triviallySmallDiff };
}

function verdictPasses(level: string, headline: string): boolean {
  return level === 'PROGRESS' || (level === 'SOLO' && headline.includes('PASS'));
}

function reportOnlyMode(values: ParsedValues): boolean {
  return values['report-only'] === true || values['no-gate'] === true;
}

function applyGateExitCode(code: number, values: ParsedValues, lang: CliLang): number {
  if (!reportOnlyMode(values)) return code;
  process.stderr.write(tCli('cli.run.report_only_gate_skipped', lang));
  return 0;
}

async function emitEvaluationVerdict(report: EvaluationReport, values: ParsedValues): Promise<number> {
  const { computeVerdict, formatVerdictText } = await import('../../eval-core/verdict.js');
  const result = computeVerdict(report, verdictOptions(values));
  console.log(formatVerdictText(result, { verbose: true }));
  return verdictPasses(result.level, result.headline) ? 0 : 1;
}

function batchItemFallbackReport(
  batch: BatchEvaluationReport,
  item: BatchEvaluationReport['items'][number],
): EvaluationReport {
  return {
    kind: 'evaluation',
    id: item.reportId,
    meta: {
      ...batch.meta,
      variants: ['baseline', item.name],
      sampleCount: item.sampleCount,
      totalCostUSD: item.totalCostUSD,
      artifactHashes: item.artifactHash ? { [item.name]: item.artifactHash } : {},
    },
    summary: item.summary,
    results: [],
    ...(item.variance ? { variance: item.variance } : {}),
  } as EvaluationReport;
}

async function loadBatchChildReports(
  batch: BatchEvaluationReport,
  reportsDir: string,
  lang: CliLang,
): Promise<EvaluationReport[]> {
  const { createFileStore } = await import('../../server/report-store.js');
  const store = createFileStore(reportsDir);
  const reports: EvaluationReport[] = [];
  for (const item of batch.items) {
    const loaded = await store.get(item.reportId);
    if (loaded?.kind === 'evaluation') {
      reports.push(loaded);
    } else {
      process.stderr.write(tCli('cli.run.batch_child_report_missing', lang, { id: item.reportId }));
      reports.push(batchItemFallbackReport(batch, item));
    }
  }
  return reports;
}

async function emitBatchVerdict(
  report: BatchEvaluationReport,
  reportsDir: string,
  values: ParsedValues,
  lang: CliLang,
): Promise<number> {
  const { computeVerdict } = await import('../../eval-core/verdict.js');
  const childReports = await loadBatchChildReports(report, reportsDir, lang);
  const results = childReports.map((child) => ({
    id: child.id,
    treatment: child.meta.variants[1] ?? child.id,
    verdict: computeVerdict(child, verdictOptions(values)),
  }));
  const passed = results.filter((r) => verdictPasses(r.verdict.level, r.verdict.headline)).length;
  const failed = results.length - passed;

  const status = lang === 'zh'
    ? (failed === 0 ? '通过' : '未通过')
    : (failed === 0 ? 'PASS' : 'FAIL');
  console.log(tCli('cli.run.batch_verdict_header', lang, {
    status,
    passed,
    total: results.length,
  }));
  for (const result of results) {
    console.log(`  ${result.verdict.level}: ${result.treatment} — ${result.verdict.headline}`);
  }
  return failed === 0 ? 0 : 1;
}

async function announceSavedReport({
  report,
  filePath,
  reportsDir,
  values,
  lang,
}: {
  report: EvaluationReport | BatchEvaluationReport;
  filePath: string;
  reportsDir: string;
  values: ParsedValues;
  lang: CliLang;
}): Promise<void> {
  const tally = computeRunTally(report);
  process.stderr.write(tCli(report.kind === 'batch-evaluation' ? 'cli.run.batch_complete' : 'cli.run.eval_complete', lang));
  process.stderr.write(tCli('cli.run.tally', lang, tally));
  process.stderr.write(tCli('cli.run.report_saved', lang, { path: filePath }));

  if (!values['no-serve'] && process.stdout.isTTY) {
    const { createReportServer } = await import('../../server/report-server.js');
    const server: ReportServer = createReportServer({ reportsDir });
    const serverUrl: string = await server.start();
    const reportUrl: string = `${serverUrl}/reports/${report.id}`;
    process.stderr.write(tCli('cli.run.report_server_running', lang, { url: serverUrl }));
    process.stderr.write(tCli('cli.run.report_server_view', lang, { url: reportUrl }));
    process.stderr.write(tCli('cli.run.report_server_stop', lang));

    const { platform } = await import('node:os');
    const openCmd: string = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
    const { execFile: execFileCb } = await import('node:child_process');
    execFileCb(openCmd, [reportUrl], () => undefined);
  } else if (!values['no-serve']) {
    process.stderr.write(tCli('cli.run.no_serve_in_non_tty', lang));
    process.stderr.write(tCli('cli.run.no_serve_view_hint', lang, { id: report.id, dir: reportsDir }));
  }
}

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  // 注: 这里**不**给 parseArgs default 值, 否则 values.xxx 永远不为 undefined,
  // CLI > eval.yaml > hardcoded-default 三级 fallback 区分不开 ("用户没传" vs "用户传了等于 default 值")。
  // hardcoded default 在下面处理 undefined 时显式给。
  const { values, config, evalConfig } = parseRunConfig(argv, {
    blind: { type: 'boolean' },
    repeat: { type: 'string' },
    'judge-repeat': { type: 'string' },
    bootstrap: { type: 'boolean' },
    'bootstrap-samples': { type: 'string' },
    'gold-dir': { type: 'string' },
    'no-debias-length': { type: 'boolean' },
    'budget-usd': { type: 'string' },
    'budget-per-sample-usd': { type: 'string' },
    'budget-per-sample-ms': { type: 'string' },
    threshold: { type: 'string', default: '3.5' },
    'trivial-diff': { type: 'string' },
    'report-only': { type: 'boolean' },
    'no-gate': { type: 'boolean' },
  });

  const { runEvaluation, runMultiple, runBatchEvaluation } = await import('../../eval-workflows/run-evaluation.js');

  if (values.blind !== undefined) {
    config.blind = values.blind as boolean | undefined;
  }
  config.onProgress = makeOnProgress(lang) as unknown as ProgressCallback;

  // --repeat: CLI > eval.yaml > 1. 非 ≥1 整数时提示并钳到 1。
  const repeatRaw = values.repeat as string | undefined;
  const parsedRepeat = repeatRaw !== undefined ? Number(repeatRaw) : (evalConfig?.repeat ?? 1);
  if (repeatRaw !== undefined && (!Number.isFinite(parsedRepeat) || parsedRepeat < 1)) {
    process.stderr.write(tCli('cli.run.invalid_repeat', lang, { value: repeatRaw }));
  }
  const repeatCount: number = Math.max(1, Math.floor(parsedRepeat) || 1);

  // --judge-repeat: CLI > eval.yaml > 1.
  const judgeRepeatRaw = values['judge-repeat'] as string | undefined;
  const parsedJudgeRepeat = judgeRepeatRaw !== undefined ? Number(judgeRepeatRaw) : (evalConfig?.judgeRepeat ?? 1);
  if (judgeRepeatRaw !== undefined && (!Number.isFinite(parsedJudgeRepeat) || parsedJudgeRepeat < 1)) {
    process.stderr.write(tCli('cli.run.invalid_judge_repeat', lang, { value: judgeRepeatRaw }));
  }
  const judgeRepeatCount: number = Math.max(1, Math.floor(parsedJudgeRepeat) || 1);
  if (judgeRepeatCount > 1) config.judgeRepeat = judgeRepeatCount;

  // --budget-usd / --budget-per-sample-usd / --budget-per-sample-ms:
  //  hard budget caps. CLI flags override config-file values. When the
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

  // --no-debias-length / eval.yaml `lengthDebias: false`: opt out of length-controlled prompt。
  // Default debias-on (judge prompt v3-cot-length); flip off only to reproduce historical reports。
  // CLI 显式 --no-debias-length > eval.yaml lengthDebias > 默认 true。
  const lengthDebiasOff = (values['no-debias-length'] as boolean | undefined) === true
    || (values['no-debias-length'] === undefined && evalConfig?.lengthDebias === false);
  if (lengthDebiasOff) {
    config.lengthDebias = false;
    process.stderr.write(tCli('cli.run.no_debias_length_active', lang));
  }

  // --bootstrap / --bootstrap-samples: CLI > eval.yaml > default(on / 1000)。
  // `omk eval` owns the product default here instead of wrapper-injecting argv
  // in commands/eval.ts, so config-file opt-out stays possible.
  const bootstrapEnabled = (values.bootstrap as boolean | undefined) === true
    || (values.bootstrap === undefined && evalConfig?.bootstrap !== false);
  if (bootstrapEnabled) {
    config.bootstrap = true;
    const bsRaw = values['bootstrap-samples'] as string | undefined;
    const parsedBs = bsRaw !== undefined ? Number(bsRaw) : (evalConfig?.bootstrapSamples ?? 1000);
    if (bsRaw !== undefined && (!Number.isFinite(parsedBs) || parsedBs < 100)) {
      process.stderr.write(tCli('cli.run.invalid_bootstrap_samples', lang, { value: bsRaw }));
    }
    const bsCount = Math.max(100, Math.floor(parsedBs) || 1000);
    if (bsCount > 10000) {
      process.stderr.write(tCli('cli.run.bootstrap_samples_too_large', lang, { n: bsCount }));
    }
    config.bootstrapSamples = bsCount;
  }

  // 注入 lang 让 evaluation pipeline 能渲染 doctor 报告(失败时)。
  config.lang = lang;
  if (values['skip-connectivity'] as boolean) {
    process.stderr.write(tCli('cli.run.skip_connectivity_warning', lang) + '\n');
  }

  try {
    // --batch mode: evaluate each skill independently
    if (values.batch) {
      const { report, filePath } = await runBatchEvaluation({
        ...config,
        repeat: repeatCount,
        onSkillProgress({ phase, skill, current, total }: SkillProgressInfo): void {
          if (phase === 'start') {
            process.stderr.write(tCli('cli.run.skill_section', lang, {
              i: current ?? '', n: total ?? '', skill: skill ?? '',
            }));
          }
        },
      }) as { report: BatchEvaluationReport | DryRunBatchReport; filePath: string | null };
      console.log(JSON.stringify(report, null, 2));
      if (isDryRunBatchReport(report)) {
        console.log('Eval dry-run: no scores to check');
        throw new CliExit(0);
      }
      if (filePath) {
        await announceSavedReport({ report, filePath, reportsDir: config.outputDir, values, lang });
      }
      const exitCode = await emitBatchVerdict(report, config.outputDir, values, lang);
      throw new CliExit(applyGateExitCode(exitCode, values, lang));
    }

    let report: Report;
    let filePath: string | null;

    if (repeatCount > 1 && !config.dryRun) {
      const result = await runMultiple({
        ...config,
        repeat: repeatCount,
        onRepeatProgress({ run, total }: RepeatProgressInfo): void {
          process.stderr.write(tCli('cli.run.run_section', lang, { i: run, n: total }));
        },
      }) as { report: Report };
      report = result.report;
      filePath = null;
    } else {
      const result = (await runEvaluation({
        ...config,
        ...(repeatCount > 1 ? { repeat: repeatCount } : {}),
      })) as EvalResult;
      if (isDryRunReport(result.report)) {
        console.log(JSON.stringify(result.report, null, 2));
        console.log('Eval dry-run: no scores to check');
        throw new CliExit(0);
      }
      report = result.report as Report;
      filePath = result.filePath;
    }

    // --gold-dir / eval.yaml goldDir: compute α/κ/Pearson against gold annotations and re-persist.
    const goldDir = (values['gold-dir'] as string | undefined) ?? evalConfig?.goldDir;
    if (goldDir && filePath) {
      const { attachGoldAgreementToReport, formatGoldCompare } = await import('../../grading/gold-cli.js');
      const out = attachGoldAgreementToReport({
        report,
        goldDir,
        outputDir: config.outputDir,
        samples: config.bootstrapSamples,
      });
      if (out.result && out.gold) {
        process.stderr.write(formatGoldCompare(out.result, out.gold));
        if (out.result.contaminationWarning) {
          process.stderr.write(tCli('cli.run.contamination_warning', lang, {
            warning: out.result.contaminationWarning,
          }));
        }
      } else {
        process.stderr.write(tCli('cli.run.gold_load_failed', lang, { dir: goldDir }));
        for (const m of out.loadIssues) {
          process.stderr.write(tCli('cli.run.gold_load_issue', lang, { message: m }));
        }
      }
    }

    console.log(JSON.stringify(report, null, 2));
    if (filePath) {
      await announceSavedReport({ report, filePath, reportsDir: config.outputDir, values, lang });
    }
    const exitCode = await emitEvaluationVerdict(report, values);
    throw new CliExit(applyGateExitCode(exitCode, values, lang));
  } catch (err: unknown) {
    // CliExit 是显式 exit 信号(从 requireEvaluationReport 等子调用冒上来),
    // 保持原 code 透传;只有真正运行时错误才包装成 CliExit(1)。
    if (err instanceof CliExit) throw err;
    console.error(tCli('cli.common.error_prefix', lang, { message: (err as Error).message }));
    throw new CliExit(1);
  }
}
