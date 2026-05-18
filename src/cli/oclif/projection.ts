/**
 * Command.Loadable → 单语视图 projection。
 *
 * 单一来源「oclif Command.Loadable 暴露给 help / docs 的单语形态」。
 * help.ts 的 LangAwareHelp / docs 自动生成 等场景都从这里派生,避免每个
 * 消费者各做一遍 reflection 跟 sentinel split,oclif 升级新字段(aliases /
 * hidden / deprecationOptions)时只改一处。
 *
 * projectCommand 返回 clone,不 mutate 入参(LangAwareHelp 渲染前先 clone)。
 *
 * 已知盲区:oclif `errors/handle.js:L44` 硬编码 `new Help(config)` 不走 helpClass,
 * parse error 时 dump 出来的 FLAGS / USAGE 拿到的是原 `${zh}\n${en}` 双语 sentinel,
 * 不经 projectCommand 切单语 — 错误路径双语并列是已知 UX 限制(Phase B 评估能否
 * fork @oclif/core 修)。
 */
import type { Command } from '@oclif/core';
import { pickLang, type Lang } from './i18n.js';

export function projectCommand(cmd: Command.Loadable, lang: Lang): Command.Loadable {
  const out: Command.Loadable = { ...cmd };

  if (cmd.description !== undefined) {
    out.description = pickLang(cmd.description, lang);
  }
  if (cmd.summary !== undefined) {
    out.summary = pickLang(cmd.summary, lang);
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
    out.flags = flags as typeof cmd.flags;
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
    out.args = args as typeof cmd.args;
  }

  if (Array.isArray(cmd.examples)) {
    out.examples = cmd.examples.map((ex) => {
      if (typeof ex === 'string') return pickLang(ex, lang) ?? ex;
      return {
        ...ex,
        description: pickLang(ex.description, lang) ?? ex.description,
      };
    });
  }

  return out;
}

/** Topic 单语视图(无 flags / args / examples)。 */
export function projectTopic<T extends { description?: string }>(topic: T, lang: Lang): T {
  return {
    ...topic,
    description: pickLang(topic.description, lang) ?? topic.description,
  };
}
