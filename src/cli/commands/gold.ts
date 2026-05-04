import { resolve } from 'node:path';
import { tCli, langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS, DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import type { ReportStore } from '../../types/index.js';
import { requireEvaluationReport } from './_shared.js';

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(tCli('cli.help.gold', lang));
    process.exit(sub ? 0 : 1);
  }

  if (sub === 'init') {
    const { values } = parseArgsStrictOrExit({
      args: rest,
      options: {
        ...COMMON_OPTIONS,
        out: { type: 'string', default: './gold-dataset' },
        annotator: { type: 'string' },
      },
    });
    const { initGoldDataset } = await import('../../grading/gold-cli.js');
    try {
      const written = initGoldDataset(values.out as string, {
        annotator: values.annotator as string | undefined,
      });
      console.log(tCli('cli.gold.created_files', lang, {
        n: written.length, dir: values.out as string,
      }));
      for (const p of written) console.log(`  ${p}`);
      console.log(tCli('cli.gold.next_step_edit_annotations', lang));
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    return;
  }

  if (sub === 'validate') {
    // 走 helper 让 `omk bench gold validate <dir> --bogus` 走 unknown option 路径,
    // 而不是直接执行 validate 后再报 dataset 错。
    const { positionals } = parseArgsStrictOrExit({
      args: rest,
      allowPositionals: true,
      options: { ...COMMON_OPTIONS },
    });
    const dir = positionals[0];
    if (!dir) {
      console.error(tCli('cli.common.usage_gold_validate', lang));
      process.exit(1);
    }
    const { validateGoldDataset } = await import('../../grading/gold-cli.js');
    const result = validateGoldDataset(dir);
    if (result.ok) {
      console.log(tCli('cli.gold.validate_ok', lang, { n: result.sampleCount }));
      return;
    }
    console.error(`✗ gold dataset has ${result.issues.length} issue(s):`);
    for (const msg of result.issues) console.error(`  - ${msg}`);
    process.exit(1);
  }

  if (sub === 'compare') {
    const reportId = rest[0];
    if (!reportId) {
      console.error('Usage: omk bench gold compare <reportId> --gold-dir <dir>');
      process.exit(1);
    }
    const { values } = parseArgsStrictOrExit({
      args: rest.slice(1),
      options: {
        ...COMMON_OPTIONS,
        'gold-dir': { type: 'string' },
        variant: { type: 'string' },
        'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
        'bootstrap-samples': { type: 'string', default: '1000' },
        seed: { type: 'string' },
      },
    });
    const goldDir = values['gold-dir'] as string | undefined;
    if (!goldDir) {
      console.error('--gold-dir is required');
      process.exit(1);
    }
    const { loadGoldDataset } = await import('../../grading/gold-dataset.js');
    const { compareGoldToReport, formatGoldCompare } = await import('../../grading/gold-cli.js');
    const { createFileStore } = await import('../../server/report-store.js');

    const { dataset, issues } = loadGoldDataset(goldDir);
    if (!dataset) {
      console.error('Cannot load gold dataset:');
      for (const i of issues) console.error(`  - ${i.message}`);
      process.exit(1);
    }
    if (issues.length) {
      // Non-fatal issues (e.g. duplicate already filtered) — surface them.
      for (const i of issues) console.error(`warn: ${i.message}`);
    }

    const store: ReportStore = createFileStore(resolve(values['reports-dir'] as string));
    const report = requireEvaluationReport(await store.get(reportId), reportId, lang);

    const samples = Math.max(100, Number(values['bootstrap-samples']) || 1000);
    const seedVal = values.seed != null ? Number(values.seed) : undefined;
    const result = compareGoldToReport({
      report,
      gold: dataset,
      variant: values.variant as string | undefined,
      samples,
      seed: Number.isFinite(seedVal) ? seedVal : undefined,
    });
    console.log(formatGoldCompare(result, dataset));
    return;
  }

  console.error(`Unknown subcommand: gold ${sub}. Use init / validate / compare.`);
  process.exit(1);
}
