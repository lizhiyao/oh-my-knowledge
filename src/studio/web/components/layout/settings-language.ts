import type { Lang } from '../../../../shared/language.js';
import type { StudioLanguageChoice } from '../../../view-models/settings/settings.js';

/**
 * 保存形状：`auto` 必须整字段省略，而不是写回当前生效语言。
 * 写回等于把一次 locale 推断结果固化成显式设置，之后系统语言变了也不会再跟随。
 */
export function languageField(choice: StudioLanguageChoice): { language?: Lang } {
  return choice === 'auto' ? {} : { language: choice };
}
