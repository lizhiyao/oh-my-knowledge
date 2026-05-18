// oclif 版 eval gold topic shim — 裸 `omk eval gold` 走 oclif Help class 打 help,
// 然后 exit 1(跟 legacy CliExit(1) 行为对齐:CI 脚本靠 exit code 区分「漏写 sub-sub」)。
//
// 不再依赖 legacy hand-written usage() 字符串(已删),走 oclif-native `runCommand('help', ...)`,
// description / TOPICS 跟其它 topic 命令一致,LangAwareHelp 自动按 --lang 切。

import { Command, Flags } from '@oclif/core';
import { bilingual } from '../../oclif/i18n.js';

export default class EvalGold extends Command {
  static description = bilingual({
    zh: '管理 human-gold 标注集（init / validate / compare 三个子命令）。',
    en: 'Manage human-gold annotation datasets (sub-commands: init / validate / compare).',
  });

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
    await this.parse(EvalGold);
    // oclif 默认没内建 help command,helpClass 是 instantiable Help 子类。直接
    // new + showCommandHelp(EvalGold) 让 LangAwareHelp 按 --lang 渲染当前 topic
    // 的 description + sub-sub 列表(init / validate / compare)。
    const HelpClass = (await import('../../oclif/help.js')).default;
    const help = new HelpClass(this.config);
    await help.showCommandHelp(this.ctor as unknown as Parameters<typeof help.showCommandHelp>[0]);
    this.exit(1);
  }
}
