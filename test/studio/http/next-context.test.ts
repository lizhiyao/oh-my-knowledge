import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { CoreStudioCatalog } from '../../../src/studio/view-models/core-runs.js';
import {
  nextCatalogContext,
  nextKnowledgeContext,
  nextObserveContext,
  StudioContextMissingError,
} from '../../../src/studio/http/next-context.js';

const markers = new WeakMap<CoreStudioCatalog, string>();

function fakeCatalog(marker: string): CoreStudioCatalog {
  const catalog: CoreStudioCatalog = {
    async list() { return []; },
    async get() { return undefined; },
    async inspect() { return undefined; },
  };
  markers.set(catalog, marker);
  return catalog;
}

describe('studio next request contexts', () => {
  it('throws StudioContextMissingError when the host never injected the store', () => {
    for (const [name, context] of [
      ['catalog', nextCatalogContext],
      ['observe', nextObserveContext],
      ['knowledge', nextKnowledgeContext],
    ] as const) {
      assert.throws(
        () => context.get(),
        (error: unknown) => {
          assert.ok(error instanceof StudioContextMissingError);
          assert.equal(error.code, 'studio_context_missing');
          assert.equal(error.contextName, name);
          return true;
        },
      );
    }
  });

  it('does not leak the store outside the request scope', () => {
    const store = fakeCatalog('request');
    nextCatalogContext.run(store, () => {
      assert.equal(nextCatalogContext.get(), store);
    });
    assert.throws(() => nextCatalogContext.get(), StudioContextMissingError);
  });

  it('isolates concurrent request stores', async () => {
    const seen: unknown[] = [];
    const request = (id: string, delayMs: number) =>
      nextCatalogContext.run(fakeCatalog(id), async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        seen.push(markers.get(nextCatalogContext.get()));
      });
    await Promise.all([request('a', 30), request('b', 5), request('c', 15)]);
    assert.deepEqual(seen, ['b', 'c', 'a']);
  });
});
