/**
 * Command.Loadable → 单语视图 projection。
 *
 * 单一来源「oclif Command.Loadable 暴露给 help / docs / 错误路径的单语形态」。
 * help.ts 的 filterCommand、init hook 的 mutate、未来 docs 自动生成 / 错误
 * dump 等场景都从这里派生,避免每个消费者各做一遍 reflection 跟 sentinel
 * split,oclif 升级新字段(aliases / hidden / deprecationOptions)时只改一处。
 *
 * projectCommand 返回 clone(不 mutate 入参)。init hook 需要 in-place mutate
 * 时,先 projectCommand 再 Object.assign 回去。
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
