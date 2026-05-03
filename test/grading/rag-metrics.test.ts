import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { runAsyncAssertions, ASYNC_ASSERTION_TYPES } from '../../src/grading/assertions.js';
import type { Assertion, ExecutorFn, Sample } from '../../src/types/index.js';

const ok = (output: string): Awaited<ReturnType<ExecutorFn>> => ({
  ok: true,
  output,
  durationMs: 1, durationApiMs: 1,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  costUSD: 0.0001, stopReason: 'end_turn', numTurns: 1,
});

const mockJudge = (handler: (prompt: string) => number): ExecutorFn =>
  async ({ prompt }) => ok(JSON.stringify({ score: handler(prompt), reason: 'mock' }));

async function runSingle(sample: Sample, assertion: Assertion, output = 'output', score = 5) {
  return runAsyncAssertions(
    output,
    [assertion],
    { executor: mockJudge(() => score), judgeModel: 'm', sample, samplesDir: '.' },
  );
}

describe('RAG metrics registration', () => {
  it('all three RAG metrics are registered as async assertion types', () => {
    assert.ok(ASYNC_ASSERTION_TYPES.has('faithfulness'));
    assert.ok(ASYNC_ASSERTION_TYPES.has('answer_relevancy'));
    assert.ok(ASYNC_ASSERTION_TYPES.has('context_recall'));
  });
});

describe('faithfulness', () => {
  const sample: Sample = {
    sample_id: 's1',
    prompt: 'Q?',
    context: 'The Eiffel Tower is in Paris and is 330 meters tall.',
  };

  const faithfulnessCases = [
    { name: 'passes when score >= threshold', assertion: { type: 'faithfulness' }, output: 'The Eiffel Tower is in Paris.', score: 5, expected: true },
    { name: 'fails when score < threshold', assertion: { type: 'faithfulness' }, output: 'The Eiffel Tower is in London and is 100m tall.', score: 2, expected: false },
    { name: 'respects custom threshold', assertion: { type: 'faithfulness', threshold: 4 }, output: 'mixed answer', score: 3, expected: false },
    { name: 'uses assertion.reference when sample.context is absent', assertion: { type: 'faithfulness', reference: 'overridden context' }, sample: { sample_id: 's', prompt: 'Q?' }, expected: true },
  ] satisfies Array<{ name: string; assertion: Assertion; output?: string; score?: number; sample?: Sample; expected: boolean }>;

  it.each(faithfulnessCases)('$name', async (testCase) => {
    const r = await runSingle(testCase.sample ?? sample, testCase.assertion, testCase.output, testCase.score);
    assert.equal(r.details[0].passed, testCase.expected);
  });

  it('fails when both sample.context and assertion.reference are missing', async () => {
    const noCtx = await runSingle({ sample_id: 's', prompt: 'Q?' }, { type: 'faithfulness' });
    assert.equal(noCtx.details[0].passed, false);
    assert.match(noCtx.details[0].message ?? '', /缺少 sample.context/);
  });

  it('prompt includes the length-debias paragraph', async () => {
    let captured = '';
    const judge: ExecutorFn = async ({ prompt }) => {
      captured = prompt;
      return ok(JSON.stringify({ score: 5, reason: 'm' }));
    };
    await runAsyncAssertions('o', [{ type: 'faithfulness' }], {
      executor: judge, judgeModel: 'm', sample, samplesDir: '.',
    });
    assert.match(captured, /长度不是质量信号/);
  });
});

describe('answer_relevancy', () => {
  const sample: Sample = {
    sample_id: 's2',
    prompt: 'How tall is the Eiffel Tower?',
  };

  const answerRelevancyCases = [
    { name: 'passes when output answers the question', output: '330 meters tall.', score: 5, expected: true },
    { name: 'fails when output dodges', output: 'Eiffel was an engineer.', score: 1, expected: false },
    { name: 'does not require sample.context', output: '330m', score: 4, expected: true },
  ];

  it.each(answerRelevancyCases)('$name', async ({ output, score, expected }) => {
    const r = await runSingle(sample, { type: 'answer_relevancy' }, output, score);
    assert.equal(r.details[0].passed, expected);
  });

  it('passes the user question into the judge prompt', async () => {
    let captured = '';
    const judge: ExecutorFn = async ({ prompt }) => {
      captured = prompt;
      return ok(JSON.stringify({ score: 5, reason: 'm' }));
    };
    await runAsyncAssertions('330m', [{ type: 'answer_relevancy' }], {
      executor: judge, judgeModel: 'm', sample, samplesDir: '.',
    });
    assert.match(captured, /How tall is the Eiffel Tower/);
  });
});

describe('context_recall', () => {
  const sample: Sample = {
    sample_id: 's3',
    prompt: 'Summarize.',
    context: 'Key fact A. Key fact B. Key fact C.',
  };

  const contextRecallCases = [
    { name: 'passes when output covers gold facts', output: 'Output covers A B C.', score: 5, expected: true },
    { name: 'fails when output ignores most gold facts', output: 'Only A.', score: 1, expected: false },
  ];

  it.each(contextRecallCases)('$name', async ({ output, score, expected }) => {
    const r = await runSingle(sample, { type: 'context_recall' }, output, score);
    assert.equal(r.details[0].passed, expected);
  });

  it('fails when sample.context is missing', async () => {
    const noCtxSample: Sample = { sample_id: 's', prompt: 'Q?' };
    const missing = await runSingle(noCtxSample, { type: 'context_recall' }, 'out');
    assert.equal(missing.details[0].passed, false);
    assert.match(missing.details[0].message ?? '', /缺少/);
  });

  it('uses assertion.reference when explicitly given (even if sample.context exists)', async () => {
    let captured = '';
    const judge: ExecutorFn = async ({ prompt }) => {
      captured = prompt;
      return ok(JSON.stringify({ score: 5, reason: 'm' }));
    };
    await runAsyncAssertions('out', [{ type: 'context_recall', reference: 'EXPLICIT GOLD' }], {
      executor: judge, judgeModel: 'm', sample, samplesDir: '.',
    });
    assert.match(captured, /EXPLICIT GOLD/);
  });

  it('falls back to sample.context when no reference is given', async () => {
    let captured = '';
    const judge: ExecutorFn = async ({ prompt }) => {
      captured = prompt;
      return ok(JSON.stringify({ score: 5, reason: 'm' }));
    };
    await runAsyncAssertions('out', [{ type: 'context_recall' }], {
      executor: judge, judgeModel: 'm', sample, samplesDir: '.',
    });
    assert.match(captured, /Key fact A/);
  });

});

describe('judge cost is accumulated', () => {
  it('asyncCostUSD reflects all RAG metric calls', async () => {
    const sample: Sample = { sample_id: 's', prompt: 'Q?', context: 'ctx' };
    const judge = mockJudge(() => 5);
    const r = await runAsyncAssertions(
      'output',
      [
        { type: 'faithfulness' },
        { type: 'answer_relevancy' },
        { type: 'context_recall' },
      ],
      { executor: judge, judgeModel: 'm', sample, samplesDir: '.' },
    );
    assert.equal(r.details.length, 3);
    assert.ok(r.judgeCostUSD! > 0, `expected accumulated cost, got ${r.judgeCostUSD}`);
    assert.ok(Math.abs(r.judgeCostUSD! - 0.0003) < 1e-6, 'three calls × $0.0001 = $0.0003');
  });
});
