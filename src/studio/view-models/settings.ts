import type { UserSettings, UserSettingsStore } from '../../evidence/storage/user-settings.js';
export interface StudioSettings {
  settings: UserSettings;
  revision: string;
  effective: ReturnType<UserSettingsStore['resolve']>;
  defaults: ReturnType<UserSettingsStore['resolve']>;
  path: string;
  overrides: string[];
}
