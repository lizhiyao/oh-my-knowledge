import { resolve } from 'node:path';
import { CliExit } from '../cli-exit.js';
import { tCli, langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS, DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import type { JudgeConfig, ReportStore } from '../../types/index.js';
import { requireEvaluationReport } from './_shared.js';

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const [kind, reportId, ...rest] = argv;
  if (!kind) {
    console.log(usage(lang));
    throw new CliExit(1);
  }
  if (kind !== 'length') {
    console.error(`Unknown debias validation kind: ${kind}. Use "length".`);
    throw new CliExit(1);
  }
  if (!reportId) {
    console.error('Usage: omk eval debias length <reportId>');
    throw new CliExit(1);
  }

  const { values } = parseArgsStrictOrExit({
    args: rest,
    options: {
      ...COMMON_OPTIONS,
      'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
      samples: { type: 'string' },
      variant: { type: 'string' },
      'judge-models': { type: 'string' },
      'bootstrap-samples': { type: 'string', default: '1000' },
      seed: { type: 'string' },
    },
  });

  const { parseJudgeModelsArgOrExit } = await import('../parse-run-config.js');
  const cliJudgeModels = (values['judge-models'] as string | undefined) !== undefined
    ? parseJudgeModelsArgOrExit(values['judge-models'] as string)
    : undefined;
  if (cliJudgeModels && cliJudgeModels.length > 1) {
    console.error(tCli('cli.common.judge_models_single_only', lang, { cmd: 'eval debias' }));
    throw new CliExit(2);
  }

  const { createFileStore } = await import('../../server/report-store.js');
  const store: ReportStore = createFileStore(resolve(values['reports-dir'] as string));
  const report = requireEvaluationReport(await store.get(reportId), reportId, lang);
  const samplesPath = (values.samples as string | undefined) ?? report.meta?.request?.samplesPath;
  if (!samplesPath) {
    console.error('Cannot find samples path. Pass --samples <path> or ensure report has request.samplesPath.');
    throw new CliExit(1);
  }

  const { loadSamples } = await import('../../inputs/load-samples.js');
  const { samples } = loadSamples(samplesPath);
  const debiasJudges: JudgeConfig[] = cliJudgeModels
    ?? (report.meta?.judgeModels?.[0]
        ? [{ executor: report.meta.judgeModels[0].executor, model: report.meta.judgeModels[0].model }]
        : []);
  if (debiasJudges.length === 0) {
    console.error(tCli('cli.common.no_judge_model', lang));
    throw new CliExit(1);
  }

  process.stderr.write(lang === 'zh'
    ? '\n⚠ eval debias 会重判所有 sample × variant，judge 成本大约翻倍。\n'
    : '\n⚠ eval debias will re-judge all sample × variant pairs; judge cost will roughly double.\n');

  const { createExecutor } = await import('../../executors/index.js');
  const judgeExecutor = createExecutor(debiasJudges[0].executor);
  const judgeModel = debiasJudges[0].model;
  const { validateLengthDebias, formatDebiasValidate } = await import('../../grading/debias-validate.js');
  const seedVal = values.seed != null ? Number(values.seed) : undefined;
  const bsRaw = Number(values['bootstrap-samples']) || 1000;
  const result = await validateLengthDebias({
    report,
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

function usage(lang: 'zh' | 'en'): string {
  return lang === 'zh'
    ? '用法：omk eval debias length <reportId> [--samples <path>] [--judge-models <executor:model>]'
    : 'Usage: omk eval debias length <reportId> [--samples <path>] [--judge-models <executor:model>]';
}
