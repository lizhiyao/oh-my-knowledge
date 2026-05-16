import { Args, Command, Flags } from '@oclif/core';
import { bilingual } from '../i18n.js';

// oclif 版 init — 透传 argv 给生产 src/cli/commands/init.ts execute()。
// 仅 lang flag + 可选 positional targetDir(默认 '.')。

export default class Init extends Command {
  static description = bilingual({
    zh: '初始化 omk 项目脚手架（skills/ + eval-samples.json 模板）。',
    en: 'Scaffold an omk project (skills/ + eval-samples.json templates).',
  });

  static examples = [
    {
      description: bilingual({
        zh: '在当前目录初始化',
        en: 'Init in current directory',
      }),
      command: '<%= config.bin %> init',
    },
    {
      description: bilingual({
        zh: '在指定目录初始化',
        en: 'Init in specified directory',
      }),
      command: '<%= config.bin %> init my-project',
    },
  ];

  static args = {
    targetDir: Args.string({
      description: bilingual({
        zh: '初始化目标目录，默认当前目录（.）',
        en: 'Target directory, defaults to current directory (.)',
      }),
      required: false,
    }),
  };

  static flags = {
    lang: Flags.string({
      description: bilingual({
        zh: '输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。',
        en: 'Output language zh|en. Priority: CLI > OMK_LANG env > zh.',
      }),
      options: ['zh', 'en'],
      default: 'zh',
      env: 'OMK_LANG',
    }),
  };

  async run(): Promise<void> {
    await this.parse(Init);
    const argv = this.argv;
    const { execute } = await import('../../commands/init.js');
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
