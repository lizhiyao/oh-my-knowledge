import { Command, Help } from '@oclif/core';
import { resolveLang, type Lang } from './i18n.js';
import { projectCommand, projectTopic } from './projection.js';

// LangAwareHelp:oclif Help 子类,按 --lang / OMK_LANG 切 description / flags
// 的双语 sentinel 到单语再交给 super 渲染。`--help` 路径(formatCommand /
// showCommandHelp / formatTopics)都走 projectCommand 投影成单语。
//
// 错误帮助也由 run.ts 使用本类呈现。语言优先级：
// --lang CLI flag > OMK_LANG env > zh。

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
