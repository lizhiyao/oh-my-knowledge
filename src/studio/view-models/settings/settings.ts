import type { Lang } from '../../../shared/language.js';
import type { UserSettings, UserSettingsStore } from '../../../evidence/storage/user-settings.js';

/** 表单里的语言取值：`auto` = 不写入设置文件，交回解析链（OMK_LANG → 系统 locale → zh）。 */
export type StudioLanguageChoice = Lang | 'auto';
export interface StudioSettings {
  settings: UserSettings;
  revision: string;
  effective: ReturnType<UserSettingsStore['resolve']>;
  defaults: Omit<ReturnType<UserSettingsStore['resolve']>, 'language'>;
  path: string;
  overrides: string[];
}
