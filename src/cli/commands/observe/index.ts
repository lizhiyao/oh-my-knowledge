import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { BaseCommand } from '../../oclif/base-command.js';
import { tCli } from '../../lib/i18n.js';

// 裸 `omk observe <sessions-dir>` 已弃用别名 —— 转发到 `omk observe health`，并打一行 stderr 弃用提示。
// 保留 args/flags 仅供 `omk observe --help` 渲染(描述里标弃用)；run() 不自己解析，直接透传原始 argv，
// 让 observe:health 按它自己的口径解析。子命令 ingest / inbox / show 不受影响。

export default class Observe extends BaseCommand {
  static description = bilingual({
    zh: '（已弃用，改用 omk observe health）分析 sessions 目录的 skill 调用健康度。子命令:ingest / inbox / show。',
    en: '(Deprecated, use omk observe health) Analyze skill invocation health from sessions dir. Subcommands: ingest / inbox / show.',
  });

  // strict=false:别名只透传，不对 health 的 flags 做二次校验，避免未知 flag 在此层报错。
  static strict = false;

  static examples = [
    {
      description: bilingual({
        zh: '已弃用，等价于 omk observe health',
        en: 'Deprecated, equivalent to omk observe health',
      }),
      command: '<%= config.bin %> observe health ~/.claude/sessions --last 7d',
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
    const lang = this.lang;
    process.stderr.write(tCli('cli.observe.deprecated_alias', lang));
    // 透传原始 argv（含 flags），交给 observe:health 解析执行。
    await this.config.runCommand('observe:health', this.argv);
  }
}
