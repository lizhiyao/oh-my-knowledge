import { resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../../../oclif/i18n.js';
import { integerStringParser } from '../../../oclif/parsers.js';
import { CliExit } from '../../../lib/cli-exit.js';
import { projectReportsDir, globalReportsDir } from '../../../../eval-core/measurement-dirs.js';

export default class EvalGoldCompare extends BaseCommand {
  static description = bilingual({
    zh: '把一组 Core run 观测跟 gold dataset 对比，计算 bootstrap CI 后的 agreement。',
    en: 'Compare Core run observations against a gold dataset with bootstrap-CI agreement.',
  });

  static args = {
    runId: Args.string({
      description: bilingual({ zh: 'Core run ID。', en: 'Core run ID.' }),
      required: true,
    }),
  };

  static flags = {
    lang: LANG_FLAG,
    'gold-dir': Flags.string({
      description: bilingual({ zh: 'gold dataset 目录，必填', en: 'Gold dataset dir (required)' }),
    }),
    target: Flags.string({
      description: bilingual({
        zh: '显式选择 Core target ID。',
        en: 'Explicit Core target ID.',
      }),
    }),
    evaluator: Flags.string({
      description: bilingual({ zh: '显式选择 Core evaluator ID。', en: 'Explicit Core evaluator ID.' }),
    }),
    metric: Flags.string({
      description: bilingual({ zh: '显式选择 Core metric ID。', en: 'Explicit Core metric ID.' }),
    }),
    'trial-index': Flags.string({
      description: bilingual({ zh: '显式选择 trial index。', en: 'Explicit trial index.' }),
      parse: integerStringParser('--trial-index', { min: 0 }),
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
      const runId = args.runId;
      if (!runId) {
        console.error('Usage: omk eval gold compare <runId> --gold-dir <dir> --target <id> --evaluator <id> --metric <id>');
        throw new CliExit(1);
      }
      const goldDir = flags['gold-dir'];
      if (!goldDir) {
        console.error('--gold-dir is required');
        throw new CliExit(1);
      }
      const { loadGoldDataset } = await import('../../../../grading/gold-dataset.js');
      const {
        createNodeCoreContentStore,
        createNodeCoreRunArtifactStore,
        createOverlayCoreRunArtifactStore,
      } = await import('../../../../eval-workflows/artifact-store/index.js');
      const { compareGoldToCoreRun } = await import(
        '../../../../eval-workflows/downstream-projections/index.js'
      );

      const { dataset, issues } = loadGoldDataset(goldDir);
      if (!dataset) {
        console.error('Cannot load gold dataset:');
        for (const i of issues) console.error(`  - ${i.message}`);
        throw new CliExit(1);
      }
      for (const i of issues) console.error(`warn: ${i.message}`);

      const storeOf = (directory: string) => createNodeCoreRunArtifactStore(directory, {
        contentResolver: createNodeCoreContentStore(resolve(directory, 'content')),
      });
      const store = flags['reports-dir']
        ? storeOf(resolve(flags['reports-dir']))
        : createOverlayCoreRunArtifactStore(storeOf(projectReportsDir()), [storeOf(globalReportsDir())]);
      const source = await store.get(runId);
      if (source === undefined) {
        console.error(lang === 'zh'
          ? `找不到 Core run「${runId}」；旧 evaluation report 不再支持 gold compare。`
          : `Core run "${runId}" was not found; legacy evaluation reports are no longer supported.`);
        throw new CliExit(1);
      }
      if (!flags.target || !flags.evaluator || !flags.metric) {
        console.error(lang === 'zh'
          ? '--target、--evaluator、--metric 均为必填；Core 不会隐式合并多个观测。'
          : '--target, --evaluator, and --metric are required; Core never pools observations implicitly.');
        throw new CliExit(1);
      }
      const samples = Math.max(100, Number(flags['bootstrap-samples'] ?? 1000) || 1000);
      const seedVal = flags.seed != null ? Number(flags.seed) : undefined;
      const result = compareGoldToCoreRun({
        source,
        gold: dataset,
        selector: {
          targetId: flags.target,
          evaluatorId: flags.evaluator,
          metricId: flags.metric,
          ...(flags['trial-index'] === undefined ? {} : {
            trialIndex: Number(flags['trial-index']),
          }),
        },
        bootstrapSamples: samples,
        ...(Number.isFinite(seedVal) ? { bootstrapSeed: seedVal } : {}),
      });
      console.log(JSON.stringify(result, null, 2));
    });
  }
}
