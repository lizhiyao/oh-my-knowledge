import { resolve } from 'node:path';
import { Args, Command, Flags } from '@oclif/core';
import { bilingual } from '../../i18n.js';
import { runLegacyCommand } from '../../run-legacy.js';
import { CliExit } from '../../../cli-exit.js';

export default class ObserveIngest extends Command {
  static description = bilingual({
    zh: '把 trace 目录 ingest 成 observation inbox 报告。',
    en: 'Ingest trace dir into observation inbox report.',
  });

  static args = {
    traceDir: Args.string({
      description: bilingual({
        zh: 'trace 目录路径。',
        en: 'Trace dir path.',
      }),
      required: true,
    }),
  };

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      default: 'zh',
    }),
    'output-dir': Flags.string({
      description: bilingual({
        zh: '输出目录，默认 ~/.oh-my-knowledge/observations',
        en: 'Output dir, default ~/.oh-my-knowledge/observations',
      }),
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ObserveIngest);
    await runLegacyCommand(this, async () => {
      const dir = args.traceDir;
      if (!dir) {
        // oclif Args.required:true 已经保证非空,这里仍兜底防御。
        throw new CliExit(1);
      }
      const tracePath = resolve(dir);
      const { existsSync } = await import('node:fs');
      if (!existsSync(tracePath)) {
        console.error(`Trace path does not exist: ${tracePath}`);
        throw new CliExit(1);
      }
      const { buildObservationInboxReport, saveObservationInboxReport, DEFAULT_OBSERVATIONS_DIR } = await import('../../../../observability/inbox.js');
      const outDir = resolve(flags['output-dir'] || DEFAULT_OBSERVATIONS_DIR);
      const { loadObservationReviewState } = await import('../../../../observability/review-state.js');
      const report = buildObservationInboxReport(tracePath, { reviewState: loadObservationReviewState(outDir) });
      const path = saveObservationInboxReport(report, outDir);
      console.log(JSON.stringify(report, null, 2));
      process.stderr.write(`observe inbox written to: ${path}\n`);
    });
  }
}
