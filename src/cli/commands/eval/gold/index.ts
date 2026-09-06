// 裸 `omk eval gold` 显示帮助并退出 1，让自动化能识别缺少子命令。
// 复用当前 HelpClass，保持语言选择和子命令列表与 CLI 一致。

import { BaseCommand } from '../../../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../../../oclif/i18n.js';

export default class EvalGold extends BaseCommand {
  static description = bilingual({
    zh: '管理 human-gold 标注集（init / validate / compare 三个子命令）。',
    en: 'Manage human-gold annotation datasets (sub-commands: init / validate / compare).',
  });

  static flags = {
    lang: LANG_FLAG,
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
