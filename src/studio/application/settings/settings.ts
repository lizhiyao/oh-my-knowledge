import { globalLayout } from '../../../evidence/storage/layout.js';
import { UserSettingsStore } from '../../../evidence/storage/user-settings.js';
export function studioSettings(store = new UserSettingsStore()) {
  return { ...store.read(), effective: store.resolve(), path: store.path,
    // 语言不在 defaults 里：它的内置默认就是「没有保存过」，实际取值由 effective 反映
    // （OMK_LANG → 已保存 → 系统 locale → zh）。表单用「自动」表达这一档。
    defaults: { workspace: globalLayout(store.root).knowledgeDir, executor: 'codex', model: '' },
    overrides: ['OMK_LANG', 'OMK_EXECUTOR', 'OMK_MODEL'].filter(key => Boolean(process.env[key]?.trim())) };
}
export function saveStudioSettings(settings: unknown, revision: string, store = new UserSettingsStore()) {
  store.save(settings, revision);
  return studioSettings(store);
}
