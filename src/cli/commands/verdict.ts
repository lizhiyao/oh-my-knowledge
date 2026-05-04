import { resolve } from 'node:path';
import { tCli, langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS, DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import type { ReportStore } from '../../types/index.js';
import { requireEvaluationReport } from './_shared.js';

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const reportId = argv[0];
  if (!reportId || reportId === '--help' || reportId === '-h') {
    console.log(tCli('cli.help.verdict', lang));
    process.exit(reportId ? 0 : 1);
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

  // Exit code reflects ship recommendation: 0 only on PROGRESS / SOLO-pass.
  // NOISE / UNDERPOWERED / CAUTIOUS / REGRESS all exit 1 so this composes
  // with shell `&&` chains in CI.
  if (result.level === 'PROGRESS') {
    process.exit(0);
  }
  if (result.level === 'SOLO' && result.headline.includes('PASS')) {
    process.exit(0);
  }
  process.exit(1);
}
