import 'server-only';
import type { CoreStudioCatalog } from '../core-runs/contracts';
import type { ObservePage } from '../http/observe-page';

// The host supplies an AsyncLocalStorage store for each request. The symbol bridges
// Next's server bundle and the CLI module graph without sharing a mutable catalog.
export function requestCatalog(): CoreStudioCatalog {
  const context = Reflect.get(globalThis, Symbol.for('omk.studio.next.catalog')) as
    { getStore(): CoreStudioCatalog | undefined } | undefined;
  const catalog = context?.getStore();
  if (!catalog) throw new Error('core_studio_source_unavailable');
  return catalog;
}

export function requestObservePage(): ObservePage {
  const context = Reflect.get(globalThis, Symbol.for('omk.studio.next.observe')) as
    { getStore(): ObservePage | undefined } | undefined;
  const page = context?.getStore();
  if (!page) throw new Error('studio_source_unavailable');
  return page;
}

export function requestKnowledgePage(): import('../http/knowledge-page').KnowledgePage {
  const context = Reflect.get(globalThis, Symbol.for('omk.studio.next.knowledge')) as
    { getStore(): import('../http/knowledge-page').KnowledgePage | undefined } | undefined;
  const page = context?.getStore();
  if (!page) throw new Error('studio_source_unavailable');
  return page;
}
