import 'server-only';
import type { CoreStudioCatalog } from '../core-runs/contracts';

// The host supplies an AsyncLocalStorage store for each request. The symbol bridges
// Next's server bundle and the CLI module graph without sharing a mutable catalog.
export function requestCatalog(): CoreStudioCatalog {
  const context = Reflect.get(globalThis, Symbol.for('omk.studio.next.catalog')) as
    { getStore(): CoreStudioCatalog | undefined } | undefined;
  const catalog = context?.getStore();
  if (!catalog) throw new Error('core_studio_source_unavailable');
  return catalog;
}
