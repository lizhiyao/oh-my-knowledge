import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { BaseCommand } from '../../oclif/base-command.js';
import { CliExit } from '../../lib/cli-exit.js';
import { tCli } from '../../lib/i18n.js';

// 裸 `omk observe <sessions-dir>` 已弃用 —— 不再直接做健康分析,给了 sessions 参数即报错引导到 `omk observe health`。
// 保留 args/flags 仅为让旧式调用(如 `omk observe <dir> --last 7d`)能优雅解析到引导信息,而非抛未知 flag。
// 子命令 ingest / inbox / show 不受影响,经各自命令文件路由。

export default class Observe extends BaseCommand {
  static description = bilingual({
    zh: '观测命令族入口。健康分析请用 omk observe health（裸 omk observe <sessions> 已弃用）。子命令:ingest / inbox / show。',
    en: 'Observe command family. Use omk observe health for analysis (bare omk observe <sessions> is deprecated). Subcommands: ingest / inbox / show.',
  });

  static examples = [
    {
      description: bilingual({
        zh: '健康分析（替代已弃用的裸 omk observe）',
        en: 'Health analysis (replaces the deprecated bare omk observe)',
      }),
      command: '<%= config.bin %> observe health ~/.claude/sessions --last 7d',
    },
  ];

  static args = {
    sessionsDir: Args.string({
      description: bilingual({
        zh: 'sessions 目录路径（已弃用，请改用 omk observe health <sessions>）',
        en: 'Sessions dir path (deprecated, use omk observe health <sessions>)',
      }),
      required: false,
    }),
  };

  static flags = {
    lang: LANG_FLAG,
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
        zh: '健康报告输出目录，默认 ~/.oh-my-knowledge/observe-health',
        en: 'Health report output dir, default ~/.oh-my-knowledge/observe-health',
      }),
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(Observe);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      if (args.sessionsDir) {
        // 裸 omk observe <sessions> 已弃用,不再直接分析 —— 明确报错引导到 omk observe health。
        console.error(tCli('cli.observe.deprecated_alias', lang).trim());
        throw new CliExit(1);
      }
      // 无 sessions 参数:展示观测命令族 help（列出 health / ingest / inbox / show）。
      console.error(tCli('cli.help.observe', lang).trim());
      throw new CliExit(1);
    });
  }
}
