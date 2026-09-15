import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { CoreStudioRunCard } from '../../../src/studio/view-models/measure/core-runs.js';
import {
  nextKnowledgeContext,
  nextMeasureRunsContext,
  nextObserveContext,
  StudioContextMissingError,
} from '../../../src/studio/http/next-context.js';

const markers = new WeakMap<CoreStudioRunCard[], string>();

function fakeRuns(marker: string): CoreStudioRunCard[] {
  const runs: CoreStudioRunCard[] = [];
  markers.set(runs, marker);
  return runs;
}

describe('studio next request contexts', () => {
  it('throws StudioContextMissingError when the host never injected the store', () => {
    for (const [name, context] of [
      ['measureRuns', nextMeasureRunsContext],
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
    const store = fakeRuns('request');
    nextMeasureRunsContext.run(store, () => {
      assert.equal(nextMeasureRunsContext.get(), store);
    });
    assert.throws(() => nextMeasureRunsContext.get(), StudioContextMissingError);
  });

  it('isolates concurrent request stores', async () => {
    const seen: unknown[] = [];
    const request = (id: string, delayMs: number) =>
      nextMeasureRunsContext.run(fakeRuns(id), async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        seen.push(markers.get(nextMeasureRunsContext.get()));
      });
    await Promise.all([request('a', 30), request('b', 5), request('c', 15)]);
    assert.deepEqual(seen, ['b', 'c', 'a']);
  });
});
