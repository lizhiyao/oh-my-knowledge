import { Command, Help } from '@oclif/core';
import { pickLang, resolveLang, type Lang } from './i18n.js';

// LangAwareHelp:oclif Help 子类,按 --lang / OMK_LANG 把 description / flags
// 里的双语 sentinel 串切成单语再交给 super 渲染。覆盖四个钩子:
// - showCommandHelp:打 top 行用 command.description.split('\\n')[0],不
//   filter 命令就漏切;在这里把 command 整体过滤一遍。
// - formatCommand:body 区(USAGE / FLAGS / EXAMPLES / DESCRIPTION),正常 filter。
// - formatCommands:topic 列表(`omk studio --help` 这种),同 filter。
// - formatTopics:TOPICS 区(`omk --help` 顶层 + `omk eval --help` 子级),
//   oclif 直接 description.split('\\n')[0] 取首行,对 bilingual sentinel 永远
//   选 zh;这里 filter 后再传给 super。

function filterCommand(cmd: Command.Loadable, lang: Lang): Command.Loadable {
  const clone: Command.Loadable = { ...cmd };
  clone.description = pickLang(cmd.description, lang);
  clone.summary = pickLang(cmd.summary, lang);

  if (Array.isArray(cmd.examples)) {
    clone.examples = cmd.examples.map((ex) => {
      if (typeof ex === 'string') return pickLang(ex, lang) ?? ex;
      return {
        ...ex,
        description: pickLang(ex.description, lang) ?? ex.description,
      };
    });
  }

  if (cmd.flags) {
    const flags: Record<string, unknown> = {};
    for (const [name, flag] of Object.entries(cmd.flags)) {
      const f = flag as { description?: string; summary?: string };
      flags[name] = {
        ...flag,
        description: pickLang(f.description, lang) ?? f.description,
        summary: pickLang(f.summary, lang) ?? f.summary,
      };
    }
    clone.flags = flags as typeof cmd.flags;
  }

  if (cmd.args) {
    const args: Record<string, unknown> = {};
    for (const [name, arg] of Object.entries(cmd.args)) {
      const a = arg as { description?: string };
      args[name] = {
        ...arg,
        description: pickLang(a.description, lang) ?? a.description,
      };
    }
    clone.args = args as typeof cmd.args;
  }
  return clone;
}

export default class LangAwareHelp extends Help {
  private get lang(): Lang {
    return resolveLang(process.argv);
  }

  formatCommand(command: Command.Loadable): string {
    return super.formatCommand(filterCommand(command, this.lang));
  }

  formatCommands(commands: Command.Loadable[]): string {
    return super.formatCommands(commands.map((c) => filterCommand(c, this.lang)));
  }

  async showCommandHelp(command: Command.Loadable): Promise<void> {
    return super.showCommandHelp(filterCommand(command, this.lang));
  }

  async showTopicHelp(topic: { name: string; description?: string }): Promise<void> {
    return super.showTopicHelp(filterTopic(topic, this.lang));
  }

  formatTopics(topics: Array<{ name: string; description?: string }>): string {
    return super.formatTopics(topics.map((t) => filterTopic(t, this.lang)));
  }
}

function filterTopic<T extends { description?: string }>(topic: T, lang: Lang): T {
  return {
    ...topic,
    description: pickLang(topic.description, lang) ?? topic.description,
  };
}
