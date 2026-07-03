import { Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { BaseCommand } from '../../oclif/base-command.js';
import { enumStringParser, integerStringParser, numberStringParser } from '../../oclif/parsers.js';
import { CliExit } from '../../lib/cli-exit.js';
import { tCli, type CliLang } from '../../lib/i18n.js';
import { parseRunConfig } from '../../lib/parse-run-config.js';
import { makeOnProgress } from '../../lib/progress.js';
import { computeRunTally } from '../../lib/run-tally.js';
import type { EvalArgs, EvalFlags } from '../../lib/cmd-flags.js';
import type { BatchEvaluationReport, EvaluationReport, Report, ProgressCallback } from '../../../types/index.js';
import type { DryRunBatchReport, DryRunReport } from '../../../eval-workflows/run-evaluation.js';
import type { EvalResult, ReportServer } from '../../lib/shared.js';
import { DEFAULT_BOOTSTRAP_SAMPLES } from '../../../eval-core/bootstrap.js';
import { DEFAULT_GATE_THRESHOLD } from '../../../eval-core/verdict.js';
import { EVALUATION_REPORT_SCHEMA_VERSION } from '../../../eval-core/evaluation-reporting.js';
import {
  findSingleTreatmentDeprecatedSamplesHint,
  hasUsableSamplesPath,
} from '../../../inputs/sample-locator.js';

// oclif 版 eval(默认 = run 模式) — 单次 typed parse 之后业务 inline。flag schema
// 镜像 RUN_OPTIONS + eval-runner extra = 41 flag。具体语义跟约束在 parseRunConfig 里。
//
// `omk eval gold ...` 由 src/cli/commands/eval/gold/{init,validate,compare}.ts
// 处理,oclif 文件目录路由自动接管,不进 eval.ts。

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

function isDryRunReport(report: unknown): report is DryRunReport {
  return Boolean(report && typeof report === 'object' && (report as { dryRun?: unknown }).dryRun === true);
}

function isDryRunBatchReport(report: unknown): report is DryRunBatchReport {
  return isDryRunReport(report) && (report as { batch?: unknown }).batch === true;
}

function verdictOptions(values: ParsedValues): { gateThreshold: number | undefined; triviallySmallDiff: number | undefined } {
  const rawThreshold = values.threshold as string | undefined;
  // 不传 --threshold 时返回 undefined,由 computeVerdict 应用 DEFAULT_GATE_THRESHOLD ——
  // 避免在此再硬编码一份 3.5(单一来源在 verdict.ts)。
  const gateThreshold = rawThreshold !== undefined && Number.isFinite(Number(rawThreshold))
    ? Number(rawThreshold)
    : undefined;
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

/**
 * 完整 report JSON 是**机器输出**:重定向 / 管道(`omk eval > r.json`、`| jq`)时吐到 stdout 供下游消费。
 * 交互式 TTY 下报告已存盘、(默认)还起了 report server,再刷上千行 JSON 只会把 verdict 淹没在屏幕外 ——
 * 故只在非 TTY(stdout 被重定向 / 管道)时 dump。dry-run 的 JSON 是用户显式索取的产物,不走此门控。
 */
function emitReportJson(report: unknown): void {
  if (!process.stdout.isTTY) {
    console.log(JSON.stringify(report, null, 2));
  }
}

/**
 * 给人读的 verdict 文案:stdout 是 TTY 时进 stdout(交互终端没有 JSON,verdict 就是答案),
 * 否则进 stderr —— 与 emitReportJson 配对,保证非 TTY 的 stdout 是**纯 report JSON**,
 * `omk eval | jq` / `> report.json` 不会被末尾拼上的人类文案噎住(否则 JSON.parse 直接失败)。
 */
function emitVerdictText(text: string): void {
  // 与 console.log 等价(对单个字符串 = write(text + '\n')),只切换目标流,逐字节保留既有文案。
  const stream = process.stdout.isTTY ? process.stdout : process.stderr;
  stream.write(text + '\n');
}

async function emitEvaluationVerdict(report: EvaluationReport, values: ParsedValues, lang: CliLang): Promise<number> {
  const { computeVerdict, formatVerdictText } = await import('../../../eval-core/verdict.js');
  const result = computeVerdict(report, verdictOptions(values));
  emitVerdictText(formatVerdictText(result, { verbose: true, lang }));
  await recordEvidenceSafely(report, result.level, values, lang);
  return verdictPasses(result.level, result.headline) ? 0 : 1;
}

/**
 * 把本次评测写成证据追加进**已纳管**记录(让 install 过的 skill 走到 measurable)。
 * 永不致命:管理是 eval 的旁路,写入失败 / 无匹配记录都不影响 verdict 与 exit code。
 * `--no-evidence` 关闭。仅对实际写入的记录打一行提示(无匹配则全静默)。
 */
async function recordEvidenceSafely(
  report: EvaluationReport,
  verdict: string,
  values: ParsedValues,
  lang: CliLang,
): Promise<void> {
  if (values['no-evidence'] === true) return;
  try {
    const { recordEvalEvidence } = await import('../../../managed/index.js');
    const written = recordEvalEvidence(report, verdict, new Date().toISOString());
    for (const w of written) {
      process.stderr.write(
        tCli(w.bound ? 'cli.run.evidence_recorded' : 'cli.run.evidence_recorded_unbound', lang, { name: w.name }),
      );
    }
  } catch {
    // 证据写入是旁路,任何异常都不该让评测失败
  }
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
      // item.artifactHash 来自子报告(走 aggregateReport 的整树哈),故 fallback 与之一致标当前 eval
      // report schemaVersion,避免「树哈 artifactHashes + 错位 schemaVersion」的错配。
      schemaVersion: EVALUATION_REPORT_SCHEMA_VERSION,
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
  // 读侧走 overlay(本次 reportsDir 优先 → 全局兜底):写默认翻项目后,batch.json 引用的存量 / 全局子报告
  // 仍能 get 命中,不致降级到 batchItemFallbackReport(来自 batch metadata 的过时数据)。
  const { createOverlayReportStore } = await import('../../../server/report-store.js');
  const { globalReportsDir } = await import('../../../eval-core/measurement-dirs.js');
  const store = createOverlayReportStore(reportsDir, globalReportsDir());
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
  const { computeVerdict } = await import('../../../eval-core/verdict.js');
  const childReports = await loadBatchChildReports(report, reportsDir, lang);
  const results = childReports.map((child) => ({
    id: child.id,
    treatment: child.meta.variants[1] ?? child.id,
    verdict: computeVerdict(child, verdictOptions(values)),
  }));
  // batch 每个子报告各自是一份独立 skill 的评测 → 各自写证据。
  for (const child of childReports) {
    const v = results.find((r) => r.id === child.id)?.verdict.level ?? 'SOLO';
    await recordEvidenceSafely(child, v, values, lang);
  }
  const passed = results.filter((r) => verdictPasses(r.verdict.level, r.verdict.headline)).length;
  const failed = results.length - passed;

  const status = lang === 'zh'
    ? (failed === 0 ? '通过' : '未通过')
    : (failed === 0 ? 'PASS' : 'FAIL');
  emitVerdictText(tCli('cli.run.batch_verdict_header', lang, {
    status,
    passed,
    total: results.length,
  }));
  for (const result of results) {
    emitVerdictText(`  ${result.verdict.level}: ${result.treatment} — ${result.verdict.headline}`);
  }
  const next = lang === 'zh'
    ? (failed === 0
      ? '全部通过，可以进入发布流程：请留存这些报告作为发布证据；如果是受管 skill，再运行 `omk promote`。'
      : '先处理未通过的 skill；逐个打开对应报告，看最差层和失败用例后再重跑。')
    : (failed === 0
      ? 'all skills passed and are ready for release: keep these reports as release evidence; for managed skills, run `omk promote`.'
      : 'fix the failing skills first; open each report, inspect the weakest layer and failing samples, then re-run.');
  emitVerdictText(tCli('cli.run.batch_verdict_next_step', lang, { next }));
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
    const { createReportServer } = await import('../../../server/report-server.js');
    // eval 结束的即时 serve 刻意钉本次 outputDir(--global 时即全局),不走 overlay:它的语义是「看我刚跑的这份」,
    // 单目录保证刚写的报告(含 --global 写到全局的)一定可见;浏览全机器历史是 omk studio 的事(默认 overlay 项目优先)。
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

async function runEval(
  _args: EvalArgs,
  flags: EvalFlags,
  lang: CliLang,
): Promise<void> {
  const { values, config, evalConfig } = parseRunConfig({ ...flags } as Record<string, unknown>);

  if (!values.batch && !hasUsableSamplesPath(config.samplesPath)) {
    const treatmentRaw = typeof values.treatment === 'string' ? values.treatment : '';
    const treatments = treatmentRaw.split(',').map((v) => v.trim()).filter(Boolean);
    const deprecatedSamplesHint = !values.samples && !evalConfig?.samples && treatments.length === 1
      ? findSingleTreatmentDeprecatedSamplesHint(treatments[0], config.skillDir, process.cwd())
      : null;
    if (deprecatedSamplesHint) {
      process.stderr.write(tCli('cli.common.deprecated_skill_samples_path', lang, {
        oldPath: deprecatedSamplesHint.oldPath,
        newPath: deprecatedSamplesHint.newPath,
      }));
    }
    console.error(tCli('cli.common.error_prefix', lang, {
      message: tCli('cli.common.samples_not_found', lang, { path: config.samplesPath }),
    }));
    throw new CliExit(1);
  }

  const { runEvaluation, runMultiple, runBatchEvaluation } = await import('../../../eval-workflows/run-evaluation.js');

  config.onProgress = makeOnProgress(lang) as unknown as ProgressCallback;

  const repeatRaw = values.repeat as string | undefined;
  const parsedRepeat = repeatRaw !== undefined ? Number(repeatRaw) : (evalConfig?.repeat ?? 1);
  if (repeatRaw !== undefined && (!Number.isFinite(parsedRepeat) || parsedRepeat < 1)) {
    process.stderr.write(tCli('cli.run.invalid_repeat', lang, { value: repeatRaw }));
  }
  const repeatCount: number = Math.max(1, Math.floor(parsedRepeat) || 1);

  const holdoutRatioRaw = values['holdout-ratio'] as string | undefined;
  const parsedHoldoutRatio = holdoutRatioRaw !== undefined ? Number(holdoutRatioRaw) : (evalConfig?.holdoutRatio ?? 0);
  if (holdoutRatioRaw !== undefined && (!Number.isFinite(parsedHoldoutRatio) || parsedHoldoutRatio <= 0 || parsedHoldoutRatio >= 1)) {
    process.stderr.write(tCli('cli.run.invalid_holdout_ratio', lang, { value: holdoutRatioRaw }));
  }
  if (parsedHoldoutRatio > 0 && parsedHoldoutRatio < 1) config.holdoutRatio = parsedHoldoutRatio;

  const judgeRepeatRaw = values['judge-repeat'] as string | undefined;
  const parsedJudgeRepeat = judgeRepeatRaw !== undefined ? Number(judgeRepeatRaw) : (evalConfig?.judgeRepeat ?? 1);
  if (judgeRepeatRaw !== undefined && (!Number.isFinite(parsedJudgeRepeat) || parsedJudgeRepeat < 1)) {
    process.stderr.write(tCli('cli.run.invalid_judge_repeat', lang, { value: judgeRepeatRaw }));
  }
  const judgeRepeatCount: number = Math.max(1, Math.floor(parsedJudgeRepeat) || 1);
  if (judgeRepeatCount > 1) config.judgeRepeat = judgeRepeatCount;

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

  const lengthDebiasOff = (values['no-debias-length'] as boolean | undefined) === true
    || (values['no-debias-length'] === undefined && evalConfig?.lengthDebias === false);
  if (lengthDebiasOff) {
    config.lengthDebias = false;
    process.stderr.write(tCli('cli.run.no_debias_length_active', lang));
  }

  const bootstrapEnabled = (values.bootstrap as boolean | undefined) === true
    || (values.bootstrap === undefined && evalConfig?.bootstrap !== false);
  if (bootstrapEnabled) {
    config.bootstrap = true;
    const bsRaw = values['bootstrap-samples'] as string | undefined;
    const parsedBs = bsRaw !== undefined ? Number(bsRaw) : (evalConfig?.bootstrapSamples ?? DEFAULT_BOOTSTRAP_SAMPLES);
    if (bsRaw !== undefined && (!Number.isFinite(parsedBs) || parsedBs < 100)) {
      process.stderr.write(tCli('cli.run.invalid_bootstrap_samples', lang, { value: bsRaw }));
    }
    const bsCount = Math.max(100, Math.floor(parsedBs) || DEFAULT_BOOTSTRAP_SAMPLES);
    if (bsCount > 10000) {
      process.stderr.write(tCli('cli.run.bootstrap_samples_too_large', lang, { n: bsCount }));
    }
    config.bootstrapSamples = bsCount;
  }

  config.lang = lang;
  if (values['skip-connectivity'] as boolean) {
    process.stderr.write(tCli('cli.run.skip_connectivity_warning', lang) + '\n');
  }

  try {
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
      if (isDryRunBatchReport(report)) {
        console.log(JSON.stringify(report, null, 2));
        console.log(tCli('cli.run.dry_run_no_scores', lang));
        throw new CliExit(0);
      }
      emitReportJson(report);
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
        console.log(tCli('cli.run.dry_run_no_scores', lang));
        throw new CliExit(0);
      }
      report = result.report as Report;
      filePath = result.filePath;
    }

    const goldDir = (values['gold-dir'] as string | undefined) ?? evalConfig?.goldDir;
    if (goldDir && filePath) {
      const { attachGoldAgreementToReport, formatGoldCompare } = await import('../../../grading/gold-cli.js');
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

    emitReportJson(report);
    if (filePath) {
      await announceSavedReport({ report, filePath, reportsDir: config.outputDir, values, lang });
    }
    const exitCode = await emitEvaluationVerdict(report, values, lang);
    throw new CliExit(applyGateExitCode(exitCode, values, lang));
  } catch (err: unknown) {
    if (err instanceof CliExit) throw err;
    console.error(tCli('cli.common.error_prefix', lang, { message: (err as Error).message }));
    throw new CliExit(1);
  }
}

export default class Eval extends BaseCommand {
  static description = bilingual({
    zh: '跑评测：对一个 control vs 多个 treatment skill 做对照试验，产 verdict 报告。',
    en: 'Run evaluation: control vs treatment(s) comparison, produce verdict report.',
  });

  static examples = [
    {
      description: bilingual({
        zh: '最简对照:baseline vs my-skill',
        en: 'Minimal A/B: baseline vs my-skill',
      }),
      command: '<%= config.bin %> eval --control baseline --treatment my-skill',
    },
    {
      description: bilingual({
        zh: 'eval.yaml 驱动 + bootstrap CI',
        en: 'eval.yaml driven + bootstrap CI',
      }),
      command: '<%= config.bin %> eval --config eval.yaml --bootstrap',
    },
  ];

  static flags = {
    lang: LANG_FLAG,
    // ── 实验角色 ──
    control: Flags.string({
      description: bilingual({ zh: 'control variant 表达式（仅 artifact 身份）', en: 'Control variant expr (artifact identity only)' }),
    }),
    treatment: Flags.string({
      description: bilingual({
        zh: 'treatment variant 列表，逗号分隔（仅 artifact 身份）',
        en: 'Treatment variants, comma-separated (artifact identity only)',
      }),
    }),
    'control-cwd': Flags.string({
      description: bilingual({
        zh: 'control 的 runtime context 目录',
        en: 'Runtime context dir for control',
      }),
    }),
    'treatment-cwd': Flags.string({
      description: bilingual({
        zh: 'treatment 的 runtime context 目录列表，逗号分隔、与 --treatment 按序对齐（空位 = 无 cwd）',
        en: 'Runtime context dirs for treatments, comma-separated, index-aligned with --treatment (blank = none)',
      }),
    }),
    config: Flags.string({
      description: bilingual({ zh: 'eval.yaml 路径', en: 'eval.yaml path' }),
    }),
    samples: Flags.string({
      description: bilingual({
        zh: '用例文件路径。默认项目级 eval-samples.json，也接受 .yaml/.yml；单 treatment 时可自动发现 <skill>/.omk/。',
        en: 'Samples path. Defaults to project-level eval-samples.json (also .yaml/.yml); single-treatment runs can auto-discover <skill>/.omk/.',
      }),
    }),
    'skill-dir': Flags.string({
      description: bilingual({ zh: 'skill 目录，默认 skills', en: 'Skill dir, default skills' }),
    }),
    // ── 模型 / 执行器 ──
    model: Flags.string({
      description: bilingual({ zh: '被测模型', en: 'Evaluated model' }),
    }),
    executor: Flags.string({
      description: bilingual({
        zh: '执行器:claude / claude-sdk / codex / codex-sdk / openai-api / gemini / 自定义命令（默认 claude）。',
        en: 'Executor: claude / claude-sdk / codex / codex-sdk / openai-api / gemini / custom (default claude).',
      }),
    }),
    'judge-models': Flags.string({
      description: bilingual({
        zh: '评委配置，格式 executor:model[,...]，例 claude:haiku 或 claude:opus,openai-api:gpt-4o(≥ 2 个 = ensemble）。默认 <executor>:haiku。',
        en: 'Judge config: executor:model[,...]. e.g. claude:haiku or claude:opus,openai-api:gpt-4o (≥ 2 = ensemble). Default <executor>:haiku.',
      }),
    }),
    'output-dir': Flags.string({
      description: bilingual({ zh: '报告输出目录（默认项目级 .omk/reports）', en: 'Report output dir (default project .omk/reports)' }),
    }),
    global: Flags.boolean({
      description: bilingual({
        zh: '报告写全局 ~/.oh-my-knowledge/reports，而非项目 .omk/',
        en: 'Write report to global ~/.oh-my-knowledge/reports instead of project .omk/',
      }),
    }),
    // ── 评测 toggle ──
    'no-judge': Flags.boolean({
      description: bilingual({ zh: '跳过 LLM judge', en: 'Skip LLM judge' }),
    }),
    'no-cache': Flags.boolean({
      description: bilingual({ zh: '跳过 executor cache', en: 'Skip executor cache' }),
    }),
    'dry-run': Flags.boolean({
      description: bilingual({ zh: '只 plan 不实跑', en: 'Plan only, no real exec' }),
    }),
    concurrency: Flags.string({
      description: bilingual({ zh: '并发数，默认 1', en: 'Concurrency, default 1' }),
      parse: integerStringParser('--concurrency', { min: 1 }),
    }),
    timeout: Flags.string({
      description: bilingual({ zh: '单用例超时秒，默认 600', en: 'Per-sample timeout sec, default 600' }),
      parse: numberStringParser('--timeout', { min: 1 }),
    }),
    batch: Flags.boolean({
      description: bilingual({
        zh: 'batch 模式:baseline vs 每个 skill',
        en: 'Batch mode: baseline vs each skill',
      }),
    }),
    'skip-connectivity': Flags.boolean({
      description: bilingual({ zh: '跳 LLM 连通性预检', en: 'Skip LLM connectivity preflight' }),
    }),
    'skip-doctor': Flags.boolean({
      description: bilingual({
        zh: 'escape hatch:跳 doctor 健康检查门禁（默认强制启用）。沙箱 mock 提供依赖时绕开 doctor 物理路径误报；garbage-in 风险自负。',
        en: 'Escape hatch: skip the doctor health-check gate (on by default). Use when sandbox mocks supply deps; caller owns garbage-in risk.',
      }),
    }),
    'mcp-config': Flags.string({
      description: bilingual({ zh: 'MCP 配置文件路径', en: 'MCP config path' }),
    }),
    'no-serve': Flags.boolean({
      description: bilingual({ zh: '不启 report server', en: 'Do not start report server' }),
    }),
    verbose: Flags.boolean({
      description: bilingual({ zh: '详细日志', en: 'Verbose logging' }),
    }),
    retry: Flags.string({
      description: bilingual({ zh: '失败 sample 重试次数', en: 'Per-sample retry count' }),
      parse: integerStringParser('--retry', { min: 0 }),
    }),
    resume: Flags.string({
      description: bilingual({ zh: '从某次失败 run 续跑', en: 'Resume a previous failed run' }),
    }),
    'layered-stats': Flags.boolean({
      description: bilingual({ zh: '输出分层统计', en: 'Emit layered stats' }),
    }),
    'strict-baseline': Flags.boolean({
      description: bilingual({ zh: '强制 baseline 隔离（default true）', en: 'Force baseline isolation (default true)' }),
    }),
    'no-strict-baseline': Flags.boolean({
      description: bilingual({ zh: '关闭 baseline 隔离', en: 'Disable baseline isolation' }),
    }),
    effort: Flags.string({
      description: bilingual({
        zh: '被测 LLM 扩展思考预算 low/medium/high/xhigh/max（默认 low；跨 effort 报告不严格可比）。',
        en: 'Executor LLM reasoning effort low/medium/high/xhigh/max (default low; reports across efforts not strictly comparable).',
      }),
      parse: enumStringParser('--effort', ['low', 'medium', 'high', 'xhigh', 'max']),
    }),
    'no-diagnostic': Flags.boolean({
      description: bilingual({
        zh: '关闭 diagnostic 诊断 LLM 调用（默认开，给 failed sample 出「哪错了 + 怎么改」建议）。',
        en: 'Disable diagnostic LLM call (on by default; emits "what went wrong + how to fix" advice for failed samples).',
      }),
    }),
    // ── eval-runner extra ──
    repeat: Flags.string({
      description: bilingual({ zh: '每个 sample 重复跑 N 次', en: 'Repeat each sample N times' }),
      parse: integerStringParser('--repeat', { min: 1 }),
    }),
    'holdout-ratio': Flags.string({
      description: bilingual({
        zh: '留出比例 0-1（如 0.3）；切出 holdout 子集，对比 train/holdout 综合分检测过拟合',
        en: 'Holdout fraction 0-1 (e.g. 0.3); splits a holdout subset, compares train/holdout composite to flag overfitting',
      }),
      parse: numberStringParser('--holdout-ratio', { min: 0, max: 1 }),
    }),
    'judge-repeat': Flags.string({
      description: bilingual({ zh: '每个 dim 评 N 次', en: 'Judge each dim N times' }),
      parse: integerStringParser('--judge-repeat', { min: 1 }),
    }),
    bootstrap: Flags.boolean({
      description: bilingual({ zh: '加 bootstrap CI', en: 'Add bootstrap CI' }),
    }),
    'bootstrap-samples': Flags.string({
      description: bilingual({ zh: 'bootstrap 重采样次数，默认 1000', en: 'Bootstrap resamples, default 1000' }),
      parse: integerStringParser('--bootstrap-samples', { min: 100 }),
    }),
    'gold-dir': Flags.string({
      description: bilingual({ zh: 'gold dataset 目录', en: 'Gold dataset dir' }),
    }),
    'no-debias-length': Flags.boolean({
      description: bilingual({ zh: '关 length-debias（默认开）', en: 'Disable length-debias (default on)' }),
    }),
    'budget-usd': Flags.string({
      description: bilingual({ zh: '总预算上限 USD（必须 > 0，不传则无上限）', en: 'Total budget cap USD (must be > 0; omit for no cap)' }),
      parse: numberStringParser('--budget-usd', { minExclusive: 0 }),
    }),
    'budget-per-sample-usd': Flags.string({
      description: bilingual({ zh: '单 sample 预算上限 USD（必须 > 0，不传则无上限）', en: 'Per-sample budget cap USD (must be > 0; omit for no cap)' }),
      parse: numberStringParser('--budget-per-sample-usd', { minExclusive: 0 }),
    }),
    'budget-per-sample-ms': Flags.string({
      description: bilingual({ zh: '单 sample 时长上限 ms（必须 > 0，不传则无上限）', en: 'Per-sample time cap ms (must be > 0; omit for no cap)' }),
      parse: numberStringParser('--budget-per-sample-ms', { minExclusive: 0 }),
    }),
    threshold: Flags.string({
      description: bilingual({
        zh: `verdict 阈值，默认 ${DEFAULT_GATE_THRESHOLD}`,
        en: `Verdict threshold, default ${DEFAULT_GATE_THRESHOLD}`,
      }),
      parse: numberStringParser('--threshold'),
    }),
    'trivial-diff': Flags.string({
      description: bilingual({ zh: '可忽略 diff 容差，0 表示不启用容差', en: 'Trivial diff tolerance; 0 disables tolerance' }),
      parse: numberStringParser('--trivial-diff', { min: 0 }),
    }),
    'report-only': Flags.boolean({
      description: bilingual({
        zh: '生成报告并打印 verdict，但始终 exit 0(不参与 CI gate）。',
        en: 'Produce the report and print verdict, but always exit 0 (no CI gate).',
      }),
    }),
    'no-gate': Flags.boolean({
      description: bilingual({ zh: '关 verdict gate', en: 'Disable verdict gate' }),
    }),
    'no-evidence': Flags.boolean({
      description: bilingual({
        zh: '不把本次评测写成证据追加进受管记录(默认会为已 install 的 skill 自动写)。',
        en: 'Do not append this run as evidence to managed records (auto-written for installed skills by default).',
      }),
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Eval);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      await runEval(args as Record<string, never>, { ...flags, lang }, lang);
    });
  }
}
