import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateSamples } from '../lib/generator.js';

describe('generateSamples', () => {
  it('is a function', () => {
    assert.equal(typeof generateSamples, 'function');
  });

  it('throws on invalid executor (script not found)', async () => {
    await assert.rejects(
      () => generateSamples({ skillContent: 'test', count: 1, executorName: 'nonexistent' }),
      /ENOENT|failed/,
    );
  });
});
