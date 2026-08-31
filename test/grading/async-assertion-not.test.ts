import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it, vi } from 'vitest';
import { runAsyncAssertions } from '../../src/grading/assertions.js';
import type {
  Assertion,
  ExecResult,
  ExecutorFn,
  Sample,
} from '../../src/types/index.js';

const samplesDir = fileURLToPath(new URL('../', import.meta.url));
const sample: Sample = {
  sample_id: 'async-not',
  prompt: 'What is the answer?',
  context: 'Grounded reference context.',
};

function completed(output: string): ExecutorFn {
  return async (): Promise<ExecResult> => ({
    ok: true,
    output,
    durationMs: 1,
    durationApiMs: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUSD: 0,
    stopReason: 'end_turn',
    numTurns: 1,
  });
}

const failed: ExecutorFn = async (): Promise<ExecResult> => ({
  ok: false,
  output: null,
  error: 'fixture provider failure',
  durationMs: 1,
  durationApiMs: 1,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUSD: 0,
  stopReason: 'error',
  numTurns: 0,
});

async function run(assertion: Assertion, executor: ExecutorFn) {
  return runAsyncAssertions('Actual answer', [assertion], {
    executor,
    judgeModel: 'judge-model',
    sample,
    samplesDir,
  });
}

describe('legacy async assertion negation', () => {
  it.each([
    'semantic_similarity',
    'faithfulness',
    'answer_relevancy',
    'context_recall',
  ])('inverts only valid pass/fail readings for %s', async (type) => {
    const rawPass = await run(
      { type, not: true, reference: 'Expected answer' },
      completed('{"score":5,"reason":"valid pass"}'),
    );
    assert.equal(rawPass.details[0].passed, false);

    const rawFail = await run(
      { type, not: true, reference: 'Expected answer' },
      completed('{"score":2,"reason":"valid fail"}'),
    );
    assert.equal(rawFail.details[0].passed, true);
  });

  it.each([
    'semantic_similarity',
    'faithfulness',
    'answer_relevancy',
    'context_recall',
  ])('keeps provider failure failed for negated %s', async (type) => {
    const result = await run(
      { type, not: true, reference: 'Expected answer' },
      failed,
    );
    assert.equal(result.details[0].passed, false);
  });

  it.each([
    'plain text',
    '{"score":"5","reason":"coerced"}',
    '{"score":6,"reason":"out of range"}',
    '{"score":5}',
  ])('keeps invalid semantic readings failed under not: true: %s', async (output) => {
    const result = await run(
      { type: 'semantic_similarity', not: true, reference: 'Expected answer' },
      completed(output),
    );
    assert.equal(result.details[0].passed, false);
  });

  it.each([
    'faithfulness',
    'answer_relevancy',
    'context_recall',
  ])('keeps invalid RAG readings failed under not: true for %s', async (type) => {
    const result = await run(
      { type, not: true, reference: 'Expected answer' },
      completed('{"score":"5","reason":"coerced"}'),
    );
    assert.equal(result.details[0].passed, false);
  });

  it.each([
    ['pass', true],
    ['fail', false],
  ] as const)('preserves a valid custom %s result without negation', async (
    value,
    expected,
  ) => {
    const result = await run({
      type: 'custom',
      fn: 'fixtures/custom-assertion-outcomes.mjs',
      value,
    }, completed('{}'));
    assert.equal(result.details[0].passed, expected);
  });

  it.each([
    ['pass', false],
    ['fail', true],
    ['throw', false],
    ['invalid', false],
  ] as const)('handles custom raw outcome %s without turning invalidity into success', async (
    value,
    expected,
  ) => {
    const result = await run({
      type: 'custom',
      fn: 'fixtures/custom-assertion-outcomes.mjs',
      value,
      not: true,
    }, completed('{}'));
    assert.equal(result.details[0].passed, expected);
  });

  it('keeps a negated custom timeout failed', async () => {
    vi.useFakeTimers();
    try {
      const pending = run({
        type: 'custom',
        fn: 'fixtures/custom-assertion-outcomes.mjs',
        value: 'timeout',
        not: true,
      }, completed('{}'));
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;
      assert.equal(result.details[0].passed, false);
      assert.match(result.details[0].message ?? '', /timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['faithfulness', 'context_recall'])('does not invert missing input for %s', async (type) => {
    const result = await runAsyncAssertions('Actual answer', [{ type, not: true }], {
      executor: completed('{"score":1,"reason":"must not run"}'),
      judgeModel: 'judge-model',
      sample: { sample_id: 'missing-input', prompt: 'Question' },
      samplesDir,
    });
    assert.equal(result.details[0].passed, false);
  });
});
