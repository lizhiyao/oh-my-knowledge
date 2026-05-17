/**
 * oclif init hook — Config.load 后、Command.run() 前触发。
 *
 * 目的:把所有 oclif Command 上的双语 description / summary / flag.description /
 * arg.description / examples[].description 在 hook 这一刻 in-place mutate 成
 * **单语**(按 resolveLang(process.argv) 当前语言),解决两个长期问题:
 *
 *   #5 错误路径双语 dump:oclif 的 errors/handle.js(L44)硬编码
 *      `new Help(config, options)` 不走 package.json.oclif.helpClass(即不走
 *      LangAwareHelp 的 filterCommand),parse error 时 dump 出来的 FLAGS / USAGE
 *      会把 `${zh}\n${en}` 形态原样吐双语两行。hook 在 mutate 之后,errors handler
 *      拿到的 Command.Loadable 字段已经是单语,dump 自然单语。
 *
 *   #8 LangAwareHelp 覆盖盲区:formatRoot / 命令级 deprecationOptions /
 *      未来 oclif 新加的 Help 渲染入口 — 只要走 cmd.description 字段都被 mutate
 *      覆盖,不需要在 LangAwareHelp 一个个 override 跟着补。LangAwareHelp 现有
 *      override 保留作 safety net(pickLang 在已切单语的 string 上 idempotent)。
 *
 * mutate 安全性:`cmd.description` / `cmd.flags[k].description` 是 Command.Loadable
 * 上的可写属性,Help class 渲染时直接读这些字段(确认过 @oclif/core/lib/help/command.js
 * 直接读 cmd.description)。mutate 不影响其它运行时(执行 Command.run() 跟
 * description 字符串无关)。
 */
import type { Hook, Command } from '@oclif/core';
import { pickLang, resolveLang, type Lang } from '../i18n.js';

function applyLang(field: string | undefined, lang: Lang): string | undefined {
  if (field === undefined) return undefined;
  return pickLang(field, lang);
}

function mutateCommand(cmd: Command.Loadable, lang: Lang): void {
  if (cmd.description !== undefined) {
    cmd.description = applyLang(cmd.description, lang);
  }
  if (cmd.summary !== undefined) {
    cmd.summary = applyLang(cmd.summary, lang);
  }

  if (cmd.flags) {
    for (const name of Object.keys(cmd.flags)) {
      const flag = cmd.flags[name] as { description?: string; summary?: string };
      if (flag.description !== undefined) {
        flag.description = applyLang(flag.description, lang);
      }
      if (flag.summary !== undefined) {
        flag.summary = applyLang(flag.summary, lang);
      }
    }
  }

  if (cmd.args) {
    for (const name of Object.keys(cmd.args)) {
      const arg = cmd.args[name] as { description?: string };
      if (arg.description !== undefined) {
        arg.description = applyLang(arg.description, lang);
      }
    }
  }

  if (Array.isArray(cmd.examples)) {
    cmd.examples = cmd.examples.map((ex) => {
      if (typeof ex === 'string') return applyLang(ex, lang) ?? ex;
      return {
        ...ex,
        description: applyLang(ex.description, lang) ?? ex.description,
      };
    });
  }
}

const hook: Hook<'init'> = async function (opts) {
  const lang = resolveLang(process.argv);
  for (const cmd of opts.config.commands) {
    mutateCommand(cmd, lang);
  }
};

export default hook;
