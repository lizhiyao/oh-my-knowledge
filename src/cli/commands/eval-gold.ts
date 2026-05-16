import { resolve } from 'node:path';
import { CliExit } from '../cli-exit.js';
import { langFromArgv, type CliLang } from '../i18n.js';
import { COMMON_OPTIONS, DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import type { ReportStore } from '../../types/index.js';
import { requireEvaluationReport } from './_shared.js';

// 三个 sub-sub handler 抽出为 named export,给 oclif Command(src/cli/oclif/commands/eval/gold/*)
// 直接 import 调用。execute() 是 legacy dispatcher 入口,仍保留(legacy --help / unknown sub 处理用)。

export async function executeInit(rest: string[], lang: CliLang): Promise<void> {
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
}

export async function executeValidate(rest: string[], lang: CliLang): Promise<void> {
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

export async function executeCompare(rest: string[], lang: CliLang): Promise<void> {
  // allowPositionals: true 让 reportId 可以出现在 flag 前或后(omk eval gold compare
  // --lang en fake-report --gold-dir ... 跟 omk eval gold compare fake-report
  // --lang en --gold-dir ... 都 work)。原写法 rest[0] 取首位会把第一个 token 当
  // reportId,跟 flag-first 的 oclif 风格冲突。
  const { values, positionals } = parseArgsStrictOrExit({
    args: rest,
    allowPositionals: true,
    options: {
      ...COMMON_OPTIONS,
      'gold-dir': { type: 'string' },
      variant: { type: 'string' },
      'reports-dir': { type: 'string', default: DEFAULT_REPORTS_DIR },
      'bootstrap-samples': { type: 'string', default: '1000' },
      seed: { type: 'string' },
    },
  });
  const reportId = positionals[0];
  if (!reportId) {
    console.error('Usage: omk eval gold compare <reportId> --gold-dir <dir>');
    throw new CliExit(1);
  }
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
}

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const [sub, ...rest] = argv;
  if (!sub) {
    console.log(usage(lang));
    throw new CliExit(1);
  }

  if (sub === 'init') {
    await executeInit(rest, lang);
    return;
  }
  if (sub === 'validate') {
    await executeValidate(rest, lang);
    return;
  }
  if (sub === 'compare') {
    await executeCompare(rest, lang);
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
