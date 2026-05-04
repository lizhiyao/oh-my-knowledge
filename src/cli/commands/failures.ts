import { resolve } from 'node:path';
import { tCli, langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS, DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import type { ReportStore, JudgeConfig } from '../../types/index.js';
import { requireEvaluationReport } from './_shared.js';

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const reportId = argv[0];
  if (!reportId) {
    console.log(tCli('cli.help.failures', lang));
    process.exit(1);
  }

  const { values } = parseArgsStrictOrExit({
    args: argv.slice(1),
    options: {
      ...COMMON_OPTIONS,
      'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
      'judge-models': { type: 'string' },
      'max-clusters': { type: 'string', default: '5' },
      threshold: { type: 'string', default: '3' },
      'max-feed': { type: 'string', default: '50' },
    },
  });

  // Parse --judge-models 在 load report 之前 fail-fast(同 debias-validate)。
  const { parseJudgeModelsArgOrExit: parseJudgesB } = await import('../parse-run-config.js');
  const cliJudgeModelsB = (values['judge-models'] as string | undefined) !== undefined
    ? parseJudgesB(values['judge-models'] as string)
    : undefined;
  if (cliJudgeModelsB && cliJudgeModelsB.length > 1) {
    console.error(tCli('cli.common.judge_models_single_only', lang, { cmd: 'failures' }));
    process.exit(2);
  }

  const { createFileStore } = await import('../../server/report-store.js');
  const store: ReportStore = createFileStore(resolve(values['reports-dir'] as string));
  const report = requireEvaluationReport(await store.get(reportId), reportId, lang);

  const failuresJudges: JudgeConfig[] = cliJudgeModelsB
    ?? (report.meta?.judgeModels?.[0]
        ? [{ executor: report.meta.judgeModels[0].executor, model: report.meta.judgeModels[0].model }]
        : []);
  if (failuresJudges.length === 0) {
    console.error(tCli('cli.common.no_judge_model', lang));
    process.exit(1);
  }

  const { createExecutor } = await import('../../executors/index.js');
  const executor = createExecutor(failuresJudges[0].executor);
  const judgeModel = failuresJudges[0].model;
  const { clusterFailures, formatFailureClusterReport } = await import('../../analysis/failure-clusterer.js');

  const out = await clusterFailures({
    report,
    executor,
    judgeModel,
    maxClusters: Number(values['max-clusters']) || 5,
    failureThreshold: Number(values.threshold) || 3,
    maxFailuresFed: Number(values['max-feed']) || 50,
  });
  console.log(formatFailureClusterReport(out));
}
