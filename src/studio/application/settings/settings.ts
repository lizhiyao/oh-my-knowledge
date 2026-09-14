import { globalLayout } from '../../../evidence/storage/layout.js';
import { UserSettingsStore } from '../../../evidence/storage/user-settings.js';
export function studioSettings(store = new UserSettingsStore()) {
  return { ...store.read(), effective: store.resolve(), path: store.path,
    defaults: { workspace: globalLayout(store.root).knowledgeDir, executor: 'codex', model: '', language: 'zh' as const },
    overrides: ['OMK_LANG', 'OMK_EXECUTOR', 'OMK_MODEL'].filter(key => Boolean(process.env[key]?.trim())) };
}
export function saveStudioSettings(settings: unknown, revision: string, store = new UserSettingsStore()) {
  store.save(settings, revision);
  return studioSettings(store);
}
