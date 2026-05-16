import { Command, Help } from '@oclif/core';
import { resolveLang, type Lang } from './i18n.js';

// 双语 hook 实验:复刻 omk 现状「--lang zh / OMK_LANG=zh 决定 help 输出语言」。
// 当前每个命令的 description / flag.description / example.description 都用 bilingual({zh,en})
// 输出 `${zh}\n${en}` 的双行串。default Help formatter 会原样打出两行,这里覆盖
// formatCommand / formatTopic 在格式化前把所有 bilingual 串过滤成单语。
//
// 风险点:这种「字符串里塞 sentinel」的方案对所有静态字段一刀切,无法区分「真正想换行」
// 跟「双语分隔」。生产化需要换更明确的标记(如 `[[ZH]]...[[EN]]...`)或换 Help class 的
// 更细 API。spike 阶段够用,实际接生产估再加 50 LOC 切串改格式 + 测试。

const BI_SPLIT = /\r?\n/;

function pickLang(text: string | undefined, lang: Lang): string | undefined {
  if (text === undefined) return undefined;
  const parts = text.split(BI_SPLIT);
  if (parts.length < 2) return text;
  // 约定 zh 行在前,en 行在后(跟 i18n.ts bilingual() 实现一致)
  if (lang === 'zh') return parts[0];
  return parts.slice(1).join('\n');
}

// 深拷贝并把所有「双语字段」按 lang 过滤。oclif Command 的元数据形如:
// { description, summary, examples: [{ description, command }], flags: { x: { description, summary, ... } }, args: { y: { description } } }
function filterCommand(cmd: Command.Loadable, lang: Lang): Command.Loadable {
  const clone: Command.Loadable = { ...cmd };
  // description / summary 直接 pick
  clone.description = pickLang(cmd.description, lang);
  clone.summary = pickLang(cmd.summary, lang);
  // examples 是 (string | Example)[]
  if (Array.isArray(cmd.examples)) {
    clone.examples = cmd.examples.map((ex) => {
      if (typeof ex === 'string') return pickLang(ex, lang) ?? ex;
      return {
        ...ex,
        description: pickLang(ex.description, lang) ?? ex.description,
      };
    });
  }
  // flags: Record<name, { description, summary, ... }>
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
  // args: 同 flags 结构
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

  // showCommandHelp 是 oclif 实际 entry,它先用 command.description.split('\n')[0]
  // 打 title,再调 formatCommand。光 hook formatCommand 不够,top title 仍会旁路 filter。
  // 这里在调 super 之前把 command 整体过滤,title + formatCommand 一并吃到 filtered 版本。
  async showCommandHelp(command: Command.Loadable): Promise<void> {
    return super.showCommandHelp(filterCommand(command, this.lang));
  }

  // topic（多 subcommand）入口同样旁路 — showHelp 派发到 showTopicHelp/showCommandHelp 之前
  // 也读 root description,这里一并过滤。
  async showTopicHelp(topic: { name: string; description?: string }): Promise<void> {
    const filtered = {
      ...topic,
      description: pickLangPublic(topic.description, this.lang) ?? topic.description,
    };
    return super.showTopicHelp(filtered);
  }
}

// 暴露给 showTopicHelp 内联用,避免直接依赖 filterCommand 的 Loadable 形态。
function pickLangPublic(text: string | undefined, lang: Lang): string | undefined {
  if (text === undefined) return undefined;
  const parts = text.split(BI_SPLIT);
  if (parts.length < 2) return text;
  if (lang === 'zh') return parts[0];
  return parts.slice(1).join('\n');
}
