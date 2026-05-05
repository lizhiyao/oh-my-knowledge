import { resolve } from 'node:path';
import { CliExit } from '../cli-exit.js';
import { langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS, DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import type { ReportStore } from '../../types/index.js';
import { requireEvaluationReport } from './_shared.js';

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const reportId = argv[0];
  if (!reportId) {
    console.log(lang === 'zh'
      ? '用法：omk export saturation <report-id> [--variant <name>]'
      : 'Usage: omk export saturation <report-id> [--variant <name>]');
    throw new CliExit(1);
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
    console.error(lang === 'zh'
      ? '该报告没有 saturation 数据，需要 --repeat ≥ 2 才会记录。'
      : 'This report has no saturation data; it requires --repeat ≥ 2.');
    throw new CliExit(1);
  }

  const targetVariants = values.variant ? [values.variant as string] : (report.meta.variants ?? []);
  console.log(lang === 'zh'
    ? '\n  Saturation 判定（读取报告中已持久化的数据）\n'
    : '\n  Saturation verdict (from persisted report data)\n');

  for (const variant of targetVariants) {
    const trace = saturation.perVariant[variant];
    if (!trace || trace.length === 0) {
      console.log(`  ${variant}: no trace data`);
      continue;
    }
    console.log(`  ${variant}:`);
    console.log(`    checkpoints: ${trace.length} (N=${trace.map((p) => p.n).join(', ')})`);
    const last = trace[trace.length - 1];
    console.log(`    last point mean=${last.mean.toFixed(3)}, CI=[${last.ciLow.toFixed(3)}, ${last.ciHigh.toFixed(3)}]`);
    const persisted = saturation.verdicts?.[variant];
    if (persisted) {
      const result = persisted.saturated ? `saturated@N=${persisted.atN ?? '?'}` : 'not saturated';
      console.log(`    verdict (${persisted.method}): ${result} - ${persisted.reason}`);
    } else if (trace.length < 5) {
      console.log(`    verdict: only ${trace.length} data points (< 5), skipping`);
    }
  }
  console.log('');
}
