import { Command, Help } from '@oclif/core';
import { resolveLang, type Lang } from './i18n.js';
import { projectCommand, projectTopic } from './projection.js';

// LangAwareHelp:oclif Help 子类,按 --lang / OMK_LANG 切 description / flags
// 的双语 sentinel 到单语再交给 super 渲染。F2 加了 init hook 后,Command.Loadable
// 已经在 Command.run() 前 in-place mutate 到单语,但 LangAwareHelp 保留作 safety
// net(projectCommand 在已经单语的 string 上 idempotent — pickLang 看 parts.length
// < 2 就原样返回),覆盖 oclif 上游可能加新 Help 渲染入口的场景。

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
