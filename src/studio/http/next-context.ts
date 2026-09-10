import { AsyncLocalStorage } from 'node:async_hooks';
import type { CoreStudioCatalog } from '../core-runs/contracts.js';

const key = Symbol.for('omk.studio.next.catalog');
export const nextCatalogContext: AsyncLocalStorage<CoreStudioCatalog> =
  Reflect.get(globalThis, key) ?? new AsyncLocalStorage<CoreStudioCatalog>();
Reflect.set(globalThis, key, nextCatalogContext);
