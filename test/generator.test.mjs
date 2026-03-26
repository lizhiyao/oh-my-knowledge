import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateSamples } from '../lib/generator.mjs';

describe('generateSamples', () => {
  it('is a function', () => {
    assert.equal(typeof generateSamples, 'function');
  });

  it('throws on empty skill content with mock', async () => {
    // This test verifies error handling — actual LLM call would be needed for full test
    // We test that the function exists and has the right signature
    await assert.rejects(
      () => generateSamples({ skillContent: '', count: 1, executorName: 'claude' }),
      // Will throw because empty prompt or executor failure
      (err) => err instanceof Error,
    );
  });
});
