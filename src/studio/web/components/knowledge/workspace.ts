import type { StudioSettings } from '../../../view-models/settings/settings.js';
/** Node owns durable preferences. URL values override this operation only. */
export async function resolveKnowledgeWorkspace(explicit = '', signal?: AbortSignal) {
  signal?.throwIfAborted();
  const response = await fetch('/api/settings', { signal });
  if (!response.ok) throw new Error('Knowledge settings unavailable.');
  const settings = await response.json() as StudioSettings;
  signal?.throwIfAborted();
  return { workspace: explicit.trim() || settings.effective.workspace, defaultWorkspace: settings.effective.workspace,
    executor: settings.effective.executor, model: settings.effective.model };
}

/** Reading an explicitly selected directory does not require model/default settings. */
export async function resolveKnowledgeDirectory(explicit = '', signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const workspace = explicit.trim() || (await resolveKnowledgeWorkspace('', signal)).workspace;
  signal?.throwIfAborted();
  return workspace;
}

/** Refresh source-scoped inbox counts after a saved review or generation. */
export function notifyKnowledgeChange(workspace: string) {
  window.dispatchEvent(new CustomEvent('omk-knowledge-changed', { detail: workspace }));
}
