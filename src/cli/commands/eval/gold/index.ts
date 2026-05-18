// oclif 版 eval gold topic shim — 裸 `omk eval gold` 走 oclif Help class 打 topic
// help,然后 exit 1(跟 legacy CliExit(1) 行为对齐:CI 脚本靠 exit code 区分「漏写
// sub-sub」)。
//
// 不再依赖 legacy hand-written usage() 字符串(已删):oclif 默认没内建 help command,
// 但 helpClass 是可实例化的 Help 子类。直接 new HelpClass(config).showCommandHelp(
// config.findCommand('eval:gold')) 让 LangAwareHelp 按 --lang 渲染当前 topic 的
// description + sub-sub 列表(init / validate / compare)。

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../oclif/base-command.js';
import { bilingual } from '../../../oclif/i18n.js';

export default class EvalGold extends BaseCommand {
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
    // 用 config.findCommand 拿到 `Command.Loadable` 形态(plain id/description/flags
    // 对象),正好 match Help.showCommandHelp 的入参类型 — 比 `this.ctor` cast 一道
    // unknown 干净。`must: true` 让找不到 id 时直接抛错(运行到这里说明 oclif
    // dispatch 已经识别 'eval:gold',self-id 必然在 commands list 里)。
    // `this.id!`:oclif Command 静态类型 `id: string | undefined`(给 plugin 留口子),
    // 但本 Command 走文件路由有稳定 id,运行时不会是 undefined。
    const loaded = this.config.findCommand(this.id!, { must: true });
    const HelpClass = (await import('../../../oclif/help.js')).default;
    const help = new HelpClass(this.config);
    await help.showCommandHelp(loaded);
    this.exit(1);
  }
}
