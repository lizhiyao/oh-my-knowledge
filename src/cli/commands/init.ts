import { resolve } from 'node:path';
import { Args } from '@oclif/core';
import { LANG_FLAG, bilingual, resolveLang } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { tCli } from '../lib/i18n.js';
import { scaffoldInitProject } from '../lib/scaffold-init.js';

export default class Init extends BaseCommand {
  static description = bilingual({
    zh: '初始化 omk 项目脚手架（skills/ + eval-samples.json 模板）。收敛后的命名是 omk eval init，本命令长期保留为别名。',
    en: 'Scaffold an omk project (skills/ + eval-samples.json templates). The converged name is `omk eval init`; this command stays as a long-lived alias.',
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
    lang: LANG_FLAG,
  };

  /** `omk init`(别名)打印收敛提示;`omk eval init`(收敛后命名)覆写为 false 不打。 */
  protected emitRenameHint = true;

  async run(): Promise<void> {
    const { args } = await this.parse(Init);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      scaffoldInitProject(resolve(args.targetDir || '.'), lang);
      // 软提示走 stderr,不污染 stdout(脚本 / 管道只取 stdout)。omk init 仍长期可用,只是建议改用新名。
      if (this.emitRenameHint) console.error(tCli('cli.init.prefer_eval_init', lang));
    });
  }
}
