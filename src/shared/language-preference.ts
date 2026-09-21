/**
 * 展示语言解析的技术叶子：优先级口径 + 系统 locale 推断。
 *
 * 与 src/shared/language.ts 分开，是因为后者登记在领域纯类型契约清单里
 * （test/architecture/domain-contract-ownership.test.ts），只能有类型；
 * 这里放运行时代码，CLI / 设置存储 / Studio 共用同一份口径。
 */
import type { Lang } from './language.js';

/**
 * 既无显式配置、系统 locale 也不在已支持语言之内时的兜底。
 * 依据根 AGENTS.md「用户可见文案中文优先」：把法语／德语／未设置等系统环境当成英文，
 * 等于悄悄把产品定位改成英文优先，因此兜底只能是 zh。
 */
export const FALLBACK_LANG: Lang = 'zh';

const SUPPORTED: readonly string[] = ['zh', 'en'];

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && SUPPORTED.includes(value);
}

/** POSIX 语义：LC_ALL 覆盖 LC_MESSAGES，两者再覆盖 LANG；`C`／`POSIX` 视为没有信号。 */
export function localeLanguageTag(env: NodeJS.ProcessEnv): string | undefined {
  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const) {
    const raw = env[key]?.trim();
    if (!raw || raw === 'C' || raw === 'POSIX') continue;
    return raw;
  }
  return undefined;
}

/**
 * 按系统 locale 推断展示语言，只认 zh／en 两类前缀，兼容 `zh_CN.UTF-8`、`en-US`、
 * macOS 的 `zh-Hans-CN`。其它语言返回 undefined 交给 FALLBACK_LANG，不当成英文。
 */
export function inferLangFromLocale(env: NodeJS.ProcessEnv): Lang | undefined {
  const tag = localeLanguageTag(env);
  if (!tag) return undefined;
  const primary = tag.split(/[_@.-]/)[0]?.toLowerCase();
  if (primary === 'zh') return 'zh';
  if (primary === 'en') return 'en';
  return undefined;
}

export interface LanguageDecision {
  lang: Lang;
  /** 语言是否来自用户留下的显式信号；据此决定首次运行引导是否出现。 */
  configured: boolean;
}

/**
 * 展示语言解析的唯一口径：显式覆盖（`--lang`）> `OMK_LANG` > 已保存设置 > 系统 locale > zh。
 * 不识别的值按「未提供」处理而不是报错，避免用户在参数解析阶段卡住。
 */
export function resolveLanguagePreference(input: {
  override?: string;
  stored?: string;
  env?: NodeJS.ProcessEnv;
}): LanguageDecision {
  const env = input.env ?? process.env;
  for (const candidate of [input.override, env.OMK_LANG, input.stored]) {
    const value = candidate?.trim();
    if (isLang(value)) return { lang: value, configured: true };
  }
  return { lang: inferLangFromLocale(env) ?? FALLBACK_LANG, configured: false };
}
