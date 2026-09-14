import type { StudioSettings } from '../../../view-models/settings.js';
/** Node owns durable preferences. URL values override this operation only. */
export async function resolveKnowledgeWorkspace(explicit = '', signal?: AbortSignal) {
  const response = await fetch('/api/settings', { signal });
  if (!response.ok) throw new Error('Knowledge settings unavailable.');
  const settings = await response.json() as StudioSettings;
  return { workspace: explicit.trim() || settings.effective.workspace, defaultWorkspace: settings.effective.workspace,
    executor: settings.effective.executor, model: settings.effective.model };
}
