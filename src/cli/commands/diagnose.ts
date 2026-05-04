import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { tCli, langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS, DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import { renderSampleDesignCoverage } from '../coverage-renderer.js';
import type { ReportStore } from '../../types/index.js';
import { requireEvaluationReport } from './_shared.js';

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const reportId = argv[0];
  if (!reportId || reportId === '--help' || reportId === '-h') {
    console.log(tCli('cli.help.diagnose', lang));
    process.exit(reportId ? 0 : 1);
  }

  const { values } = parseArgsStrictOrExit({
    args: argv.slice(1),
    options: {
      ...COMMON_OPTIONS,
      'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
      samples: { type: 'string' },
      top: { type: 'string', default: '10' },
      'duplicate-rouge': { type: 'string' },
      'ambiguous-stddev': { type: 'string' },
      'cost-k': { type: 'string' },
      'latency-k': { type: 'string' },
      flat: { type: 'string' },
    },
  });

  const { createFileStore } = await import('../../server/report-store.js');
  const store: ReportStore = createFileStore(resolve(values['reports-dir'] as string));
  const report = requireEvaluationReport(await store.get(reportId), reportId, lang);

  // Try to read the samples file for near-duplicate detection. Source order:
  //  1. --samples <path> override
  //  2. report.meta.request.samplesPath (recorded at run time)
  // If neither resolves to a readable file, skip near-duplicate gracefully.
  let samples: import('../../types/index.js').Sample[] | undefined;
  const samplesPath = (values.samples as string | undefined) ?? report.meta?.request?.samplesPath;
  if (samplesPath && existsSync(samplesPath)) {
    try {
      const { loadSamples } = await import('../../inputs/load-samples.js');
      samples = loadSamples(samplesPath).samples;
    } catch (err) {
      process.stderr.write(tCli('cli.common.warn_load_samples_failed', lang, {
        path: samplesPath, message: (err as Error).message,
      }));
    }
  }

  const topRaw = Number(values.top);
  const topN = Number.isFinite(topRaw) && topRaw > 0 ? topRaw : undefined;

  const { diagnoseSamples, formatSampleDiagnostics } = await import('../../analysis/sample-diagnostics.js');
  const diag = diagnoseSamples(report, {
    samples,
    duplicateRouge: values['duplicate-rouge'] != null ? Number(values['duplicate-rouge']) : undefined,
    ambiguousStddev: values['ambiguous-stddev'] != null ? Number(values['ambiguous-stddev']) : undefined,
    costOutlierK: values['cost-k'] != null ? Number(values['cost-k']) : undefined,
    latencyOutlierK: values['latency-k'] != null ? Number(values['latency-k']) : undefined,
    flatThreshold: values.flat != null ? Number(values.flat) : undefined,
  });
  console.log(formatSampleDiagnostics(diag, { topN, lang }));

  // Sample design science coverage block. Render after diagnose 主体,因为
  // coverage 是声明式元数据(capability/difficulty/construct/provenance)的整体分布,
  // 跟 issue list 是不同视角的两件事。优先从 samples (现场加载) 算,fallback 到
  // report.analysis.sampleQuality(报告里持久化的数据)。
  const coverageBlock = renderSampleDesignCoverage(samples, report.analysis?.sampleQuality, lang);
  if (coverageBlock) console.log(coverageBlock);

  // Exit code: 0 if health ≥ 70 and no errors; 1 otherwise. CI-friendly.
  if (diag.totals.errors === 0 && diag.healthScore >= 70) {
    process.exit(0);
  }
  process.exit(1);
}
