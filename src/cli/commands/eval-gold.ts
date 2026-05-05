import { resolve } from 'node:path';
import { CliExit } from '../cli-exit.js';
import { langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS, DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import type { ReportStore } from '../../types/index.js';
import { requireEvaluationReport } from './_shared.js';

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const [sub, ...rest] = argv;
  if (!sub) {
    console.log(usage(lang));
    throw new CliExit(1);
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
      console.log(lang === 'zh'
        ? `已在 ${values.out as string} 创建 ${written.length} 个文件：`
        : `Created ${written.length} files in ${values.out as string}:`);
      for (const p of written) console.log(`  ${p}`);
      console.log(lang === 'zh'
        ? '\n下一步：编辑 annotations.yaml 加入真实标注，然后运行 omk eval gold validate'
        : '\nNext step: edit annotations.yaml with real annotations, then run omk eval gold validate');
    } catch (err) {
      console.error((err as Error).message);
      throw new CliExit(1);
    }
    return;
  }

  if (sub === 'validate') {
    const { positionals } = parseArgsStrictOrExit({
      args: rest,
      allowPositionals: true,
      options: { ...COMMON_OPTIONS },
    });
    const dir = positionals[0];
    if (!dir) {
      console.error('Usage: omk eval gold validate <dir>');
      throw new CliExit(1);
    }
    const { validateGoldDataset } = await import('../../grading/gold-cli.js');
    const result = validateGoldDataset(dir);
    if (result.ok) {
      console.log(lang === 'zh'
        ? `✓ gold dataset OK，共 ${result.sampleCount} 条标注`
        : `✓ gold dataset OK — ${result.sampleCount} annotations`);
      return;
    }
    console.error(`✗ gold dataset has ${result.issues.length} issue(s):`);
    for (const msg of result.issues) console.error(`  - ${msg}`);
    throw new CliExit(1);
  }

  if (sub === 'compare') {
    const reportId = rest[0];
    if (!reportId) {
      console.error('Usage: omk eval gold compare <reportId> --gold-dir <dir>');
      throw new CliExit(1);
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
      throw new CliExit(1);
    }
    const { loadGoldDataset } = await import('../../grading/gold-dataset.js');
    const { compareGoldToReport, formatGoldCompare } = await import('../../grading/gold-cli.js');
    const { createFileStore } = await import('../../server/report-store.js');

    const { dataset, issues } = loadGoldDataset(goldDir);
    if (!dataset) {
      console.error('Cannot load gold dataset:');
      for (const i of issues) console.error(`  - ${i.message}`);
      throw new CliExit(1);
    }
    for (const i of issues) console.error(`warn: ${i.message}`);

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

  console.error(`Unknown subcommand: eval gold ${sub}. Use init / validate / compare.`);
  throw new CliExit(1);
}

function usage(lang: 'zh' | 'en'): string {
  return lang === 'zh'
    ? [
        'omk eval gold — 管理 human-gold 标注集',
        '',
        '用法：',
        '  omk eval gold init [--out <dir>] [--annotator <name>]',
        '  omk eval gold validate <dir>',
        '  omk eval gold compare <reportId> --gold-dir <dir>',
      ].join('\n')
    : [
        'omk eval gold — manage human-gold annotation datasets',
        '',
        'Usage:',
        '  omk eval gold init [--out <dir>] [--annotator <name>]',
        '  omk eval gold validate <dir>',
        '  omk eval gold compare <reportId> --gold-dir <dir>',
      ].join('\n');
}
