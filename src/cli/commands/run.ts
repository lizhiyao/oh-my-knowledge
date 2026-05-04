import { CliExit } from '../cli-exit.js';
import { tCli, langFromArgv } from '../i18n.js';
import { parseRunConfig } from '../parse-run-config.js';
import { makeOnProgress } from '../progress.js';
import { computeRunTally } from '../run-tally.js';
import type { Report, ProgressCallback } from '../../types/index.js';
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

  // --bootstrap / --bootstrap-samples: CLI > eval.yaml > default(off / 1000)。
  const bootstrapEnabled = (values.bootstrap as boolean | undefined) === true
    || (values.bootstrap === undefined && evalConfig?.bootstrap === true);
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
      }) as EvalResult;
      console.log(JSON.stringify(report, null, 2));
      if (filePath) {
        process.stderr.write(tCli('cli.run.batch_complete', lang));
        const tally = computeRunTally(report);
        process.stderr.write(tCli('cli.run.tally', lang, tally));
        process.stderr.write(tCli('cli.run.report_saved', lang, { path: filePath }));

        if (!values['no-serve'] && process.stdout.isTTY) {
          const { createReportServer } = await import('../../server/report-server.js');
          const server: ReportServer = createReportServer({ reportsDir: config.outputDir });
          const serverUrl: string = await server.start();
          const reportUrl: string = `${serverUrl}/reports/${report.id}`;
          process.stderr.write(tCli('cli.run.report_server_running', lang, { url: serverUrl }));
          process.stderr.write(tCli('cli.run.report_server_view', lang, { url: reportUrl }));
          process.stderr.write(tCli('cli.run.report_server_stop', lang));

          const { platform } = await import('node:os');
          const openCmd: string = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
          const { execFile: execFileCb } = await import('node:child_process');
          execFileCb(openCmd, [reportUrl], () => { });
        } else if (!values['no-serve']) {
          process.stderr.write(tCli('cli.run.no_serve_in_non_tty', lang));
          process.stderr.write(tCli('cli.run.no_serve_view_hint', lang, { dir: config.outputDir }));
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
          process.stderr.write(tCli('cli.run.run_section', lang, { i: run, n: total }));
        },
      }) as { report: Report };
      report = result.report;
      filePath = null;
    } else {
      const result = (await runEvaluation(config)) as EvalResult;
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
      process.stderr.write(tCli('cli.run.eval_complete', lang));
      const tally = computeRunTally(report);
      process.stderr.write(tCli('cli.run.tally', lang, tally));
      process.stderr.write(tCli('cli.run.report_saved', lang, { path: filePath }));

      if (!values['no-serve'] && process.stdout.isTTY) {
        // Auto-start report server
        const { createReportServer } = await import('../../server/report-server.js');
        const server: ReportServer = createReportServer({
          reportsDir: config.outputDir,
        });
        const serverUrl: string = await server.start();
        const reportUrl: string = `${serverUrl}/reports/${report.id}`;
        process.stderr.write(tCli('cli.run.report_server_running', lang, { url: serverUrl }));
        process.stderr.write(tCli('cli.run.report_server_view', lang, { url: reportUrl }));
        process.stderr.write(tCli('cli.run.report_server_stop', lang));

        // Auto-open report in browser
        const { platform } = await import('node:os');
        const openCmd: string = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
        const { execFile: execFileCb } = await import('node:child_process');
        execFileCb(openCmd, [reportUrl], () => { });
      } else if (!values['no-serve']) {
        process.stderr.write(tCli('cli.run.no_serve_in_non_tty', lang));
        process.stderr.write(tCli('cli.run.no_serve_view_hint', lang, { dir: config.outputDir }));
      }
    }
  } catch (err: unknown) {
    console.error(tCli('cli.common.error_prefix', lang, { message: (err as Error).message }));
    throw new CliExit(1);
  }
}
