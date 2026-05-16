import { Command, Flags } from '@oclif/core';
import { bilingual, t } from '../../i18n.js';

// spike 版 studio start — 验证 oclif subcommand 形态:
// 文件 src/commands/studio/start.ts + package.json oclif.topicSeparator=" "
// → CLI 实际命令 `omk-spike studio start`。
// 关注 6 项验收的第 4 项「subcommand 元数据外部可 walk」。

export default class StudioStart extends Command {
  static description = bilingual({
    zh: '启动 omk studio 报告服务,看 skill 健康/评测/观测三大维度。',
    en: 'Start the omk studio report server (skill health / eval / observe).',
  });

  static examples = [
    {
      description: bilingual({
        zh: '默认端口 0(系统分配可用端口),浏览器自动打开',
        en: 'Default port 0 (OS-assigned), browser auto-opens',
      }),
      command: '<%= config.bin %> studio start',
    },
    {
      description: bilingual({
        zh: '指定端口 + 不打开浏览器',
        en: 'Fixed port, no browser',
      }),
      command: '<%= config.bin %> studio start --port 7799 --no-serve',
    },
  ];

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      options: ['zh', 'en'],
      default: 'zh',
      env: 'OMK_LANG',
    }),
    port: Flags.integer({
      description: bilingual({
        zh: '监听端口,0 表示系统分配',
        en: 'Listen port, 0 = OS-assigned',
      }),
      default: 0,
    }),
    'no-serve': Flags.boolean({
      description: bilingual({
        zh: '只生成报告,不启动 HTTP 服务',
        en: 'Generate report only, do not start HTTP server',
      }),
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StudioStart);
    const lang = (flags.lang === 'en' ? 'en' : 'zh') as 'zh' | 'en';
    this.log(
      `[spike studio start] port=${flags.port} no-serve=${flags['no-serve']}`,
    );
    this.log(
      t(
        {
          zh: `✔ studio 已启动 port=${flags.port}(spike 占位,未实际开 server)`,
          en: `✔ studio started on port=${flags.port} (spike stub, no real server)`,
        },
        lang,
      ),
    );
  }
}
