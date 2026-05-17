import { resolve } from 'node:path';
import { CliExit } from '../cli-exit.js';
import { type CliLang } from '../i18n.js';
import { DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import type {
  GoldInitArgs,
  GoldInitFlags,
  GoldValidateArgs,
  GoldValidateFlags,
  GoldCompareArgs,
  GoldCompareFlags,
} from '../types/cmd-flags.js';
import type { ReportStore } from '../../types/index.js';
import { requireEvaluationReport } from '../_shared.js';

// 三个 sub-sub handler:oclif Command(src/cli/oclif/commands/eval/gold/*)的 run() 直接调用。
// `eval gold` topic 本身由 src/cli/oclif/commands/eval/gold.ts 处理(打 help + exit 1)。

export async function runGoldInit(
  _args: GoldInitArgs,
  flags: GoldInitFlags,
  lang: CliLang,
): Promise<void> {
  const { initGoldDataset } = await import('../../grading/gold-cli.js');
  try {
    const written = initGoldDataset(flags.out, {
      annotator: flags.annotator,
    });
    console.log(lang === 'zh'
      ? `已在 ${flags.out} 创建 ${written.length} 个文件：`
      : `Created ${written.length} files in ${flags.out}:`);
    for (const p of written) console.log(`  ${p}`);
    console.log(lang === 'zh'
      ? '\n下一步：编辑 annotations.yaml 加入真实标注，然后运行 omk eval gold validate'
      : '\nNext step: edit annotations.yaml with real annotations, then run omk eval gold validate');
  } catch (err) {
    console.error((err as Error).message);
    throw new CliExit(1);
  }
}

export async function runGoldValidate(
  args: GoldValidateArgs,
  _flags: GoldValidateFlags,
  lang: CliLang,
): Promise<void> {
  const dir = args.dir;
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

export async function runGoldCompare(
  args: GoldCompareArgs,
  flags: GoldCompareFlags,
  lang: CliLang,
): Promise<void> {
  const reportId = args.reportId;
  if (!reportId) {
    console.error('Usage: omk eval gold compare <reportId> --gold-dir <dir>');
    throw new CliExit(1);
  }
  const goldDir = flags['gold-dir'];
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

  const reportsDir = flags['reports-dir'] ?? DEFAULT_REPORTS_DIR;
  const store: ReportStore = createFileStore(resolve(reportsDir));
  const report = requireEvaluationReport(await store.get(reportId), reportId, lang);
  const samples = Math.max(100, Number(flags['bootstrap-samples'] ?? 1000) || 1000);
  const seedVal = flags.seed != null ? Number(flags.seed) : undefined;
  const result = compareGoldToReport({
    report,
    gold: dataset,
    variant: flags.variant,
    samples,
    seed: Number.isFinite(seedVal) ? seedVal : undefined,
  });
  console.log(formatGoldCompare(result, dataset));
}
