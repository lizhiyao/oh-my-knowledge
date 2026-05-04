import { resolve } from 'node:path';
import { tCli, langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS, DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import type { ReportStore } from '../../types/index.js';
import { requireEvaluationReport } from './_shared.js';

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const reportId = argv[0];
  if (!reportId) {
    console.log(tCli('cli.help.saturation', lang));
    process.exit(1);
  }

  const { values } = parseArgsStrictOrExit({
    args: argv.slice(1),
    options: {
      ...COMMON_OPTIONS,
      'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
      variant: { type: 'string' },
    },
  });

  const { createFileStore } = await import('../../server/report-store.js');
  const store: ReportStore = createFileStore(resolve(values['reports-dir'] as string));
  const report = requireEvaluationReport(await store.get(reportId), reportId, lang);

  const saturation = report.variance?.saturation;
  if (!saturation) {
    console.error(tCli('cli.saturation.no_data', lang));
    process.exit(1);
  }

  // Print the persisted verdict from the original run. The trace stores
  // (mean, ciLow, ciHigh) per checkpoint but not raw scores, so re-running
  // findSaturationPoint with different method/threshold is not possible
  // here — that would need raw scores, which would have to be persisted
  // by runMultiple. Future work: opt-in `--persist-saturation-raw` flag at
  // run time to enable post-hoc parameter sweeps.
  const variants = report.meta.variants ?? [];
  const targetVariants = values.variant ? [values.variant as string] : variants;

  console.log(tCli('cli.saturation.verdict_header', lang));
  for (const variant of targetVariants) {
    const trace = saturation.perVariant[variant];
    if (!trace || trace.length === 0) {
      console.log(tCli('cli.saturation.variant_no_trace', lang, { variant }));
      continue;
    }
    console.log(tCli('cli.saturation.variant_label', lang, { variant }));
    console.log(tCli('cli.saturation.checkpoints', lang, {
      n: trace.length, list: trace.map((p) => p.n).join(', '),
    }));
    const last = trace[trace.length - 1];
    console.log(tCli('cli.saturation.last_point', lang, {
      mean: last.mean.toFixed(3), lo: last.ciLow.toFixed(3), hi: last.ciHigh.toFixed(3),
    }));
    if (saturation.verdicts?.[variant]) {
      const v = saturation.verdicts[variant];
      const result = v.saturated
        ? tCli('cli.saturation.persisted_verdict_saturated', lang, { n: v.atN ?? '?' })
        : tCli('cli.saturation.persisted_verdict_unsaturated', lang);
      console.log(tCli('cli.saturation.persisted_verdict', lang, {
        method: v.method, result, reason: v.reason,
      }));
    } else if (trace.length < 5) {
      console.log(tCli('cli.saturation.skipped_too_few_points', lang, { n: trace.length }));
    }
  }
  console.log('');
}
