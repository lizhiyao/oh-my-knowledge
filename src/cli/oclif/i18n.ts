// oclif 路径专用 i18n helper。运行期文案使用 ../lib/i18n.ts 的 tCli ——
// 这里只提供 oclif Command static 字段需要的双语形式:
// bilingual({zh, en}) → 字符串里 `${zh}\n${en}`,LangAwareHelp.formatCommand
// 按 lang 切第一/第二行。
//
// 为什么用 \n 而不是显式 sentinel(如 [[ZH]]/[[EN]]):oclif 错误路径
// (parse fail 时)硬编码 `new Help(config)`(node_modules/@oclif/core/lib/errors/handle.js
// L44),绕过 package.json helpClass,所以 LangAwareHelp 不会被调到。
// 显式 sentinel 在错误路径会原样泄漏给用户,可读性极差;\n 退化成「两种语言
// 都各占一行」, 错误路径下用户至少能读懂。
//
// 代价:flag description 里不能用真换行 — 单行写到底,需要多段时换 prose
// 文档。
//
// 跟进(Phase B):改 oclif 上游让 errors/handle.js 尊重 helpClass / 接受双语 dump
// 不再 fix(早期 init hook description mutate 方案 PR #124 已删,接受 BREAKING-CLI)。

import { Flags } from '@oclif/core';
import { getCliLang, parseLangFromArgv } from '../lib/i18n.js';
import type { CliLang } from '../lib/i18n.js';

export type Lang = CliLang;

export { getCliLang, parseLangFromArgv };

export interface BiText {
  zh: string;
  en: string;
}

/** 把双语对象拼成 `${zh}\n${en}` 串,塞给 oclif Command 的 static description / flags.description 等字段。 */
export function bilingual(text: BiText): string {
  // 真换行会破坏 pickLang 的 split:第一行被当 zh,后续全归 en,zh 用户拿不到剩余段。
  // codegen 也跟着错位且静默(因为 codegen 跟 help 共用同一份 split,两边一起错 = 自洽通过)。
  // 单行写到底，需要多段时写入 prose 文档。
  if (text.zh.includes('\n') || text.en.includes('\n')) {
    throw new Error(
      `bilingual() does not support newlines in zh/en. Got zh=${JSON.stringify(text.zh)}, en=${JSON.stringify(text.en)}. ` +
      `Use single-line description; place long prose in documentation.`,
    );
  }
  // ejs 模板标记 `<% %>` 不允许出现在 description / flag.description / arg.description 里。
  // oclif Help 用 ejs.render(body, context) 渲染所有 section,如果未来 description 被
  // 拼了用户输入(skill 名、文件路径、env 值),`<%...%>` 会被执行成任意代码。
  // by-design 的模板只在 example.command 字段(如 `<%= config.bin %>`),那个字段不走 bilingual()。
  if (text.zh.includes('<%') || text.zh.includes('%>') || text.en.includes('<%') || text.en.includes('%>')) {
    throw new Error(
      `bilingual() text must not contain ejs template markers (<% or %>). ` +
      `oclif Help renders description through ejs; templates only belong in example.command. ` +
      `Got zh=${JSON.stringify(text.zh)}, en=${JSON.stringify(text.en)}.`,
    );
  }
  return `${text.zh}\n${text.en}`;
}

export const LANG_FLAG = Flags.string({
  description: bilingual({
    zh: '输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。',
    en: 'Output language zh|en. Priority: CLI > OMK_LANG env > zh.',
  }),
  default: 'zh',
});

/** 按 lang 把双语串切回单语;只有 1 行的串原样返回。 */
export function pickLang(text: string | undefined, lang: Lang): string | undefined {
  if (text === undefined) return undefined;
  const parts = text.split(/\r?\n/);
  if (parts.length < 2) return text;
  if (lang === 'zh') return parts[0];
  return parts.slice(1).join('\n');
}

/** 从 process.argv 解析 lang,优先级跟 ../i18n.ts 的 getCliLang 一致:CLI flag > OMK_LANG > zh。 */
export function resolveLang(argv: readonly string[] = process.argv): Lang {
  return getCliLang(parseLangFromArgv(argv));
}
