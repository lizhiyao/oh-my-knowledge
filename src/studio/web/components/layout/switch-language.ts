import type { Language } from './shell';
import type { StudioSettings } from '../../../view-models/settings/settings';

/**
 * 语言切换的唯一实现：语言是本机设置，不进地址。写设置文件（只改 language，其余字段原样带上）
 * 成功后由调用方重载当前页。读取或保存失败返回 false，调用方留在原页提示重试。
 */
export async function saveStudioLanguage(target: Language, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const current = await fetchImpl('/api/settings');
    if (!current.ok) return false;
    const data = await current.json() as StudioSettings;
    const response = await fetchImpl('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: data.revision, settings: { ...data.settings, schemaVersion: 1, language: target } }) });
    return response.ok;
  } catch { return false; }
}
