import { CliExit } from '../cli-exit.js';
import { resolve } from 'node:path';
import { tCli, langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS, DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import type { ReportStore, JudgeConfig } from '../../types/index.js';
import { requireEvaluationReport } from './_shared.js';

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub) {
    console.log(tCli('cli.help.debias_validate', lang));
    throw new CliExit(1);
  }

  if (sub !== 'length') {
    console.error(`Unknown debias-validate kind: ${sub}. Use "length".`);
    throw new CliExit(1);
  }

  const reportId = rest[0];
  if (!reportId) {
    console.error('Usage: omk bench debias-validate length <reportId>');
    throw new CliExit(1);
  }
  const { values } = parseArgsStrictOrExit({
    args: rest.slice(1),
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

  // Parse --judge-models 在 load report 之前 fail-fast。重复 entry / 缺 executor /
  // 空串等参数错误应立即给 friendly error: + exit 2,不要等到 store IO 完成才暴露。
  const { parseJudgeModelsArgOrExit: parseJudgesA } = await import('../parse-run-config.js');
  const cliJudgeModelsA = (values['judge-models'] as string | undefined) !== undefined
    ? parseJudgesA(values['judge-models'] as string)
    : undefined;
  if (cliJudgeModelsA && cliJudgeModelsA.length > 1) {
    console.error(tCli('cli.common.judge_models_single_only', lang, { cmd: 'debias-validate' }));
    throw new CliExit(2);
  }

  const { createFileStore } = await import('../../server/report-store.js');
  const store: ReportStore = createFileStore(resolve(values['reports-dir'] as string));
  const report = requireEvaluationReport(await store.get(reportId), reportId, lang);

  // Resolve samples path: --samples overrides; otherwise read from report.meta.request.
  const samplesPath = (values.samples as string | undefined)
    ?? report.meta?.request?.samplesPath;
  if (!samplesPath) {
    console.error('Cannot find samples path. Pass --samples <path> or ensure report has request.samplesPath.');
    throw new CliExit(1);
  }
  const { loadSamples } = await import('../../inputs/load-samples.js');
  const { samples } = loadSamples(samplesPath);

  const debiasJudges: JudgeConfig[] = cliJudgeModelsA
    ?? (report.meta?.judgeModels?.[0]
        ? [{ executor: report.meta.judgeModels[0].executor, model: report.meta.judgeModels[0].model }]
        : []);
  if (debiasJudges.length === 0) {
    console.error(tCli('cli.common.no_judge_model', lang));
    throw new CliExit(1);
  }

  process.stderr.write(tCli('cli.debias.warn_cost_doubles', lang));

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
