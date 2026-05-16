import { Args, Command, Flags } from '@oclif/core';
import { bilingual } from '../../i18n.js';

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
      options: ['zh', 'en'],
      default: 'zh',
      env: 'OMK_LANG',
    }),
    'output-dir': Flags.string({
      description: bilingual({
        zh: '输出目录，默认 ~/.oh-my-knowledge/observations',
        en: 'Output dir, default ~/.oh-my-knowledge/observations',
      }),
    }),
  };

  async run(): Promise<void> {
    await this.parse(ObserveIngest);
    // process.argv = [node, script, 'observe', 'ingest', ...args] → slice(4) = ...args
    const argv = process.argv.slice(4);
    const { executeIngest } = await import('../../../commands/observe.js');
    const { CliExit } = await import('../../../cli-exit.js');
    try {
      await executeIngest(argv);
    } catch (err) {
      if (err instanceof CliExit) {
        if (err.code === 0) return;
        this.exit(err.code);
      }
      throw err;
    }
  }
}
