/** Server owns filesystem defaults; the browser remembers only the user's selection. */
export async function resolveKnowledgeWorkspace(explicit = '', signal?: AbortSignal) {
  const response = await fetch('/api/knowledge/candidates', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation: 'defaults' }), signal,
  });
  if (!response.ok) throw new Error('Knowledge defaults unavailable.');
  const defaults = await response.json() as { workspace: string };
  const workspace = explicit.trim() || window.localStorage.getItem('omk.knowledge.workspace')?.trim() || defaults.workspace;
  return { workspace, defaultWorkspace: defaults.workspace };
}
