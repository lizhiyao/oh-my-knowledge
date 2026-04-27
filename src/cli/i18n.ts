import type { Lang } from '../types/shared.js';
import { CLI_DICT, type CliMessageKey } from './i18n-dict.js';

export type CliLang = Lang;

const DEFAULT_LANG: CliLang = 'zh';
const SUPPORTED: ReadonlySet<string> = new Set(['zh', 'en']);

/**
 * 优先级: --lang flag > OMK_LANG env > 默认 zh。
 * 不识别的值静默退回默认,避免在解析阶段抛错让用户卡住。
 */
export function getCliLang(flagValue?: string): CliLang {
  const candidates = [flagValue, process.env.OMK_LANG];
  for (const c of candidates) {
    if (c && SUPPORTED.has(c)) return c as CliLang;
  }
  return DEFAULT_LANG;
}

/**
 * 缺 key 时返回 key 本身,便于在 dev / CI 中肉眼/脚本发现遗漏。
 * params 用 {name} 占位符做 string 替换。
 */
export function tCli(
  key: CliMessageKey,
  lang: CliLang = DEFAULT_LANG,
  params?: Record<string, string | number>,
): string {
  const entry = CLI_DICT[key];
  if (!entry) return key;
  let text = entry[lang] ?? entry[DEFAULT_LANG] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}
