import { Args, Command, Flags } from '@oclif/core';
import { bilingual, resolveLang } from '../i18n.js';

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
      parse: async (input: string): Promise<string> => {
        // 拒绝 `omk init -- --weird` 这种把 flag 当 positional 的写法 — legacy 会
        // 创建名为 `--weird` 的目录,新人一头雾水。在 oclif Args 这层拦住更友好。
        if (input.startsWith('--')) {
          const lang = resolveLang();
          const msg = lang === 'zh'
            ? `初始化目录不能以 -- 开头：${input}（看起来是误写的 flag）`
            : `init target dir cannot start with --: ${input} (looks like a malformed flag)`;
          throw new Error(msg);
        }
        return input;
      },
    }),
  };

  static flags = {
    lang: Flags.string({
      description: bilingual({
        zh: '输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。',
        en: 'Output language zh|en. Priority: CLI > OMK_LANG env > zh.',
      }),
      default: 'zh',
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
