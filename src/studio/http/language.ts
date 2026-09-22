import { UserSettingsStore } from '../../evidence/storage/user-settings.js';
import { FALLBACK_LANG } from '../../shared/language-preference.js';
import type { Lang } from '../../shared/language.js';

/**
 * 宿主侧的展示语言：只认本机设置（`OMK_LANG` → 已保存设置 → 系统 locale → 默认），
 * 两个 Studio 宿主共用同一份口径。
 *
 * 刻意不读请求头。`x-omk-studio-lang` 是宿主注入给 RSC 的内部通道（Next 派发前覆盖写入）；
 * 若这里反过来信它，客户端就能越过「语言是本机设置」这条口径自选渲染语言。
 * 语言只是偏好：设置文件读坏时退回内置默认，页面照常可用，错误留给 /api/settings 报告。
 */
export function studioHostLanguage(): Lang {
  try { return new UserSettingsStore().resolve().language; } catch { return FALLBACK_LANG; }
}
