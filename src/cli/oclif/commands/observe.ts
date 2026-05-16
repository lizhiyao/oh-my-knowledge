import { Args, Command, Flags } from '@oclif/core';
import { bilingual } from '../i18n.js';

// oclif 版 observe 默认命令 — `omk observe <sessions-dir>` 走 executeHealth。
// 三个子命令(ingest / inbox / show)由 src/cli/oclif/commands/observe/ 文件目录托管。

export default class Observe extends Command {
  static description = bilingual({
    zh: '分析 sessions 目录的 skill 调用健康度（默认行为）。子命令:ingest / inbox / show。',
    en: 'Analyze skill invocation health from sessions dir (default). Subcommands: ingest / inbox / show.',
  });

  static examples = [
    {
      description: bilingual({
        zh: '分析最近 7 天',
        en: 'Analyze last 7 days',
      }),
      command: '<%= config.bin %> observe ~/.claude/sessions --last 7d',
    },
  ];

  static args = {
    sessionsDir: Args.string({
      description: bilingual({
        zh: 'sessions 目录路径（如 ~/.claude/sessions）',
        en: 'Sessions dir path (e.g. ~/.claude/sessions)',
      }),
      required: false,
    }),
  };

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      options: ['zh', 'en'],
      default: 'zh',
    }),
    kb: Flags.string({
      description: bilingual({ zh: '知识库 root，启用 KB-aware 分析', en: 'KB root, enables KB-aware analysis' }),
    }),
    last: Flags.string({
      description: bilingual({ zh: '时间窗(7d / 24h / 30m）', en: 'Time window (7d / 24h / 30m)' }),
    }),
    from: Flags.string({
      description: bilingual({ zh: '起始时间 ISO，优先级高于 --last', en: 'Start time ISO, overrides --last' }),
    }),
    to: Flags.string({
      description: bilingual({ zh: '结束时间 ISO', en: 'End time ISO' }),
    }),
    skills: Flags.string({
      description: bilingual({
        zh: '只看指定 skill，逗号分隔',
        en: 'Filter to specific skills, comma-separated',
      }),
    }),
    'output-dir': Flags.string({
      description: bilingual({
        zh: '分析结果输出目录',
        en: 'Analysis output directory',
      }),
    }),
  };

  async run(): Promise<void> {
    await this.parse(Observe);
    // 透传给生产 executeHealth(named export)。this.argv = oclif 切掉命令路径后的余下 argv。
    const argv = this.argv;
    const { executeHealth } = await import('../../commands/observe.js');
    const { CliExit } = await import('../../cli-exit.js');
    try {
      await executeHealth(argv);
    } catch (err) {
      if (err instanceof CliExit) {
        if (err.code === 0) return;
        this.exit(err.code);
      }
      throw err;
    }
  }
}
