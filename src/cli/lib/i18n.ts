import { UserSettingsStore } from '../../evidence/storage/user-settings.js';
import type { Lang } from '../../shared/language.js';
import {
  FALLBACK_LANG,
  resolveLanguagePreference,
  type LanguageDecision,
} from '../../shared/language-preference.js';
import { CLI_DICT, type CliMessageKey } from './i18n-dict.js';

export type CliLang = Lang;

const DEFAULT_LANG: CliLang = FALLBACK_LANG;

/**
 * main() 在子命令 parseArgs 之前就需要拿到 lang(用于打印 unknown 提示)。
 * 早期 scan argv,支持 `--lang en` 和 `--lang=en` 两种形式。
 */
export function parseLangFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lang' && i + 1 < argv.length) return argv[i + 1];
    if (a && a.startsWith('--lang=')) return a.slice('--lang='.length);
  }
  return undefined;
}

/**
 * 优先级: --lang flag > OMK_LANG env > 全局设置 > 系统 locale > 默认 zh。
 * 口径本身在 resolveLanguagePreference,与 Studio 设置解析共用。
 * 不识别的值静默退回下一级,避免在解析阶段抛错让用户卡住。
 */
export function resolveCliLang(
  flagValue?: string,
  env: NodeJS.ProcessEnv = process.env,
): LanguageDecision {
  let stored: string | undefined;
  try {
    stored = new UserSettingsStore().read().settings.language;
  } catch {
    // 设置文件不可读时不阻断命令:语言退回 locale／兜底,其余字段仍会在真正用到时报错。
    stored = undefined;
  }
  return resolveLanguagePreference({ override: flagValue, stored, env });
}

export function getCliLang(flagValue?: string, env: NodeJS.ProcessEnv = process.env): CliLang {
  return resolveCliLang(flagValue, env).lang;
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
