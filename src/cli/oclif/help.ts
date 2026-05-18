import { Command, Help } from '@oclif/core';
import { resolveLang, type Lang } from './i18n.js';
import { projectCommand, projectTopic } from './projection.js';

// LangAwareHelp:oclif Help 子类,按 --lang / OMK_LANG 切 description / flags
// 的双语 sentinel 到单语再交给 super 渲染。`--help` 路径(formatCommand /
// showCommandHelp / formatTopics)都走 projectCommand 投影成单语。
//
// 已知盲区:oclif `errors/handle.js:L44` 硬编码 `new Help(config)` 不走 helpClass,
// parse error 时 dump 出来的 FLAGS / USAGE 拿到的是原 `${zh}\n${en}` 双语 sentinel,
// LangAwareHelp 没机会拦,用户会看到双语并列。这是已知 UX 限制(Phase B 评估能否
// fork @oclif/core 修)。lang 解析跟业务侧 `resolveLang(process.argv)` 一致,
// 优先级 `--lang CLI flag > OMK_LANG env > zh`。

export default class LangAwareHelp extends Help {
  private get lang(): Lang {
    return resolveLang(process.argv);
  }

  formatCommand(command: Command.Loadable): string {
    return super.formatCommand(projectCommand(command, this.lang));
  }

  formatCommands(commands: Command.Loadable[]): string {
    return super.formatCommands(commands.map((c) => projectCommand(c, this.lang)));
  }

  async showCommandHelp(command: Command.Loadable): Promise<void> {
    return super.showCommandHelp(projectCommand(command, this.lang));
  }

  async showTopicHelp(topic: { name: string; description?: string }): Promise<void> {
    return super.showTopicHelp(projectTopic(topic, this.lang));
  }

  formatTopics(topics: Array<{ name: string; description?: string }>): string {
    return super.formatTopics(topics.map((t) => projectTopic(t, this.lang)));
  }
}
