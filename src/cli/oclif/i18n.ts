// oclif 路径专用 i18n helper。生产 i18n 还是走 ../i18n.ts (tCli / tBoth) ——
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
// 文档(legacy 路径的 cli.help.* prose 仍然继续承担长 prose 角色)。
//
// PR-E 跟进:或者改 oclif 上游让 errors/handle.js 尊重 helpClass,或者
// 自写 init hook 把 description 在 parse 前 in-place mutate。

import { getCliLang, parseLangFromArgv } from '../i18n.js';
import type { CliLang } from '../i18n.js';

export type Lang = CliLang;

export { getCliLang, parseLangFromArgv };

export interface BiText {
  zh: string;
  en: string;
}

/** 把双语对象拼成 `${zh}\n${en}` 串,塞给 oclif Command 的 static description / flags.description 等字段。 */
export function bilingual(text: BiText): string {
  return `${text.zh}\n${text.en}`;
}

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
