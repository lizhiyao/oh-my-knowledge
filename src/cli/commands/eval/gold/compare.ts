import { resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../../../oclif/i18n.js';
import { integerStringParser } from '../../../oclif/parsers.js';
import { CliExit } from '../../../lib/cli-exit.js';
import { DEFAULT_REPORTS_DIR } from '../../../lib/parse-run-config.js';
import { requireEvaluationReport } from '../../../lib/shared.js';
import type { ReportStore } from '../../../../types/index.js';

export default class EvalGoldCompare extends BaseCommand {
  static description = bilingual({
    zh: '把一份 evaluation report 跟 gold dataset 对比，计算 bootstrap CI 后的 agreement。',
    en: 'Compare an evaluation report against gold dataset, output bootstrap-CI agreement.',
  });

  static args = {
    reportId: Args.string({
      description: bilingual({ zh: 'report ID。', en: 'Report ID.' }),
      required: true,
    }),
  };

  static flags = {
    lang: LANG_FLAG,
    'gold-dir': Flags.string({
      description: bilingual({ zh: 'gold dataset 目录，必填', en: 'Gold dataset dir (required)' }),
    }),
    variant: Flags.string({
      description: bilingual({
        zh: '只比对指定 variant，默认全比',
        en: 'Compare only specified variant',
      }),
    }),
    'reports-dir': Flags.string({
      description: bilingual({
        zh: '报告目录，默认 ~/.oh-my-knowledge/reports',
        en: 'Reports dir, default ~/.oh-my-knowledge/reports',
      }),
    }),
    'bootstrap-samples': Flags.string({
      description: bilingual({
        zh: 'bootstrap 重采样次数，默认 1000',
        en: 'Bootstrap resamples, default 1000',
      }),
      parse: integerStringParser('--bootstrap-samples', { min: 100 }),
    }),
    seed: Flags.string({
      description: bilingual({ zh: 'bootstrap seed，可复现', en: 'Bootstrap seed for reproducibility' }),
      parse: integerStringParser('--seed', { min: 0 }),
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(EvalGoldCompare);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
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
      const { loadGoldDataset } = await import('../../../../grading/gold-dataset.js');
      const { compareGoldToReport, formatGoldCompare } = await import('../../../../grading/gold-cli.js');
      const { createFileStore } = await import('../../../../server/report-store.js');

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
    });
  }
}
