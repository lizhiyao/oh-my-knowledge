import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { makeOnProgress } from '../src/cli/lib/progress.js';

function captureStderr(fn: () => void): string {
  const original = process.stderr.write;
  let output = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return output;
}

describe('CLI progress', () => {
  it('marks failed completed tasks with a failure icon and error', () => {
    const output = captureStderr(() => {
      makeOnProgress('zh')({
        phase: 'done',
        completed: 1,
        total: 1,
        sample_id: 's1',
        variant: 'v1',
        durationMs: 240000,
        inputTokens: 0,
        outputTokens: 0,
        costUSD: 0,
        ok: false,
        error: 'execution timed out after 240s',
      });
    });

    assert.match(output, /⚠️/);
    assert.doesNotMatch(output, /✓/);
    assert.match(output, /execution timed out after 240s/);
  });
});
