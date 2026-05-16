import { Command, Flags } from '@oclif/core';
import { bilingual } from '../i18n.js';

// oclif 版 studio — 透传 argv 给生产 execute()。
// server 是长跑命令:生产 execute() 调 server.start() 后 await 返回 URL 然后 console.log
// 但 server 自身保持 listen,Node.js 不会主动退出。oclif 路径同理:run() 不显式 return
// 则 oclif 也不会 process.exit,server 继续 listen。Ctrl+C 走 Node 默认行为(legacy 同)。

export default class Studio extends Command {
  static description = bilingual({
    zh: '启动 omk Studio 报告服务（skill-centric 仪表盘 + 浏览器自动打开）。',
    en: 'Start omk Studio report server (skill-centric dashboard + browser auto-open).',
  });

  static examples = [
    {
      description: bilingual({ zh: '默认端口 7799', en: 'Default port 7799' }),
      command: '<%= config.bin %> studio',
    },
    {
      description: bilingual({
        zh: '指定端口，不打开浏览器',
        en: 'Custom port, no browser',
      }),
      command: '<%= config.bin %> studio --port 8080 --no-open',
    },
  ];

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      options: ['zh', 'en'],
      default: 'zh',
    }),
    port: Flags.string({
      description: bilingual({
        zh: '监听端口，默认 7799。传 0 让 OS 分配',
        en: 'Listen port, default 7799. Pass 0 for OS-assigned',
      }),
      default: '7799',
    }),
    host: Flags.string({
      description: bilingual({
        zh: '监听 host，默认 localhost。改为 0.0.0.0 暴露给局域网',
        en: 'Listen host, default localhost. Use 0.0.0.0 to expose to LAN',
      }),
    }),
    'reports-dir': Flags.string({
      description: bilingual({
        zh: '报告目录，默认 ~/.oh-my-knowledge/reports',
        en: 'Reports dir, default ~/.oh-my-knowledge/reports',
      }),
    }),
    'analyses-dir': Flags.string({
      description: bilingual({
        zh: '分析数据目录（可选）',
        en: 'Analyses dir (optional)',
      }),
    }),
    'observations-dir': Flags.string({
      description: bilingual({
        zh: '观测数据目录（可选）',
        en: 'Observations dir (optional)',
      }),
    }),
    'no-open': Flags.boolean({
      description: bilingual({
        zh: '不自动打开浏览器',
        en: 'Do not auto-open browser',
      }),
      default: false,
    }),
    dev: Flags.boolean({
      description: bilingual({
        zh: 'dev 模式：子进程启动 + 热更新',
        en: 'Dev mode: child process with hot reload',
      }),
      default: false,
    }),
  };

  async run(): Promise<void> {
    await this.parse(Studio);
    const argv = this.argv;
    const { execute } = await import('../../commands/studio.js');
    const { CliExit } = await import('../../cli-exit.js');
    try {
      await execute(argv);
    } catch (err) {
      if (err instanceof CliExit) {
        if (err.code === 0) return;
        this.exit(err.code);
      }
      throw err;
    }
  }
}
