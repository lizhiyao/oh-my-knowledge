import { AsyncLocalStorage } from 'node:async_hooks';
import type { CoreStudioCatalog } from '../core-runs/contracts.js';
import type { ObservePage } from './observe-page.js';

const key = Symbol.for('omk.studio.next.catalog');
export const nextCatalogContext: AsyncLocalStorage<CoreStudioCatalog> =
  Reflect.get(globalThis, key) ?? new AsyncLocalStorage<CoreStudioCatalog>();
Reflect.set(globalThis, key, nextCatalogContext);

const observeKey = Symbol.for('omk.studio.next.observe');
export const nextObserveContext: AsyncLocalStorage<ObservePage> =
  Reflect.get(globalThis, observeKey) ?? new AsyncLocalStorage<ObservePage>();
Reflect.set(globalThis, observeKey, nextObserveContext);

const knowledgeKey = Symbol.for('omk.studio.next.knowledge');
export const nextKnowledgeContext: AsyncLocalStorage<import('./knowledge-page.js').KnowledgePage> =
  Reflect.get(globalThis, knowledgeKey) ?? new AsyncLocalStorage<import('./knowledge-page.js').KnowledgePage>();
Reflect.set(globalThis, knowledgeKey, nextKnowledgeContext);
