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
      ? '用法：omk export verdict <report-id> [--threshold <n>] [--trivial-diff <n>]'
      : 'Usage: omk export verdict <report-id> [--threshold <n>] [--trivial-diff <n>]');
    throw new CliExit(1);
  }

  const { values } = parseArgsStrictOrExit({
    args: argv.slice(1),
    options: {
      ...COMMON_OPTIONS,
      'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
      threshold: { type: 'string' },
      'trivial-diff': { type: 'string' },
      verbose: { type: 'boolean', default: false },
    },
  });

  const { createFileStore } = await import('../../server/report-store.js');
  const store: ReportStore = createFileStore(resolve(values['reports-dir'] as string));
  const report = requireEvaluationReport(await store.get(reportId), reportId, lang);
  const { computeVerdict, formatVerdictText } = await import('../../eval-core/verdict.js');
  const { reportComparabilityWarnings, formatComparabilityWarnings } = await import('../../eval-core/comparability.js');
  const comparability = formatComparabilityWarnings(reportComparabilityWarnings(report), lang);
  if (comparability) process.stderr.write(`${comparability}\n`);

  const result = computeVerdict(report, {
    gateThreshold: values.threshold != null ? Number(values.threshold) : undefined,
    triviallySmallDiff: values['trivial-diff'] != null ? Number(values['trivial-diff']) : undefined,
  });
  console.log(formatVerdictText(result, { verbose: Boolean(values.verbose) }));

  if (result.level === 'PROGRESS') throw new CliExit(0);
  if (result.level === 'SOLO' && result.headline.includes('PASS')) throw new CliExit(0);
  throw new CliExit(1);
}
