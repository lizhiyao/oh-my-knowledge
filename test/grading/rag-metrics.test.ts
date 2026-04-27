import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { runAsyncAssertions, ASYNC_ASSERTION_TYPES } from '../../src/grading/assertions.js';
import type { ExecutorFn, Sample } from '../../src/types/index.js';

const ok = (output: string): Awaited<ReturnType<ExecutorFn>> => ({
  ok: true,
  output,
  durationMs: 1, durationApiMs: 1,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  costUSD: 0.0001, stopReason: 'end_turn', numTurns: 1,
});

const mockJudge = (handler: (prompt: string) => number): ExecutorFn =>
  async ({ prompt }) => ok(JSON.stringify({ score: handler(prompt), reason: 'mock' }));

describe('Phase 22.3 — RAG metrics registration', () => {
  it('all three RAG metrics are registered as async assertion types', () => {
    assert.ok(ASYNC_ASSERTION_TYPES.has('faithfulness'));
    assert.ok(ASYNC_ASSERTION_TYPES.has('answer_relevancy'));
    assert.ok(ASYNC_ASSERTION_TYPES.has('context_recall'));
  });
});

describe('Phase 22.3 — faithfulness', () => {
  const sample: Sample = {
    sample_id: 's1',
    prompt: 'Q?',
    context: 'The Eiffel Tower is in Paris and is 330 meters tall.',
  };

  it('passes when score >= threshold (default 3)', async () => {
    const judge = mockJudge(() => 5);
    const r = await runAsyncAssertions(
      'The Eiffel Tower is in Paris.',
      [{ type: 'faithfulness' }],
      { executor: judge, judgeModel: 'm', sample, samplesDir: '.' },
    );
    assert.equal(r.details[0].passed, true);
  });

  it('fails when score < threshold', async () => {
    const judge = mockJudge(() => 2);
    const r = await runAsyncAssertions(
      'The Eiffel Tower is in London and is 100m tall.',
      [{ type: 'faithfulness' }],
      { executor: judge, judgeModel: 'm', sample, samplesDir: '.' },
    );
    assert.equal(r.details[0].passed, false);
  });

  it('respects custom threshold', async () => {
    const judge = mockJudge(() => 3);
    const r = await runAsyncAssertions(
      'mixed answer',
      [{ type: 'faithfulness', threshold: 4 }],
      { executor: judge, judgeModel: 'm', sample, samplesDir: '.' },
    );
    assert.equal(r.details[0].passed, false);
  });

  it('fails fast when sample has no context and no reference override', async () => {
    const judge = mockJudge(() => 5);
    const noCtxSample: Sample = { sample_id: 's', prompt: 'Q?' };
    const r = await runAsyncAssertions(
      'output',
      [{ type: 'faithfulness' }],
      { executor: judge, judgeModel: 'm', sample: noCtxSample, samplesDir: '.' },
    );
    assert.equal(r.details[0].passed, false);
    assert.match(r.details[0].message ?? '', /缺少 sample.context/);
  });

  it('uses assertion.reference as override when sample.context is absent', async () => {
    const judge = mockJudge(() => 5);
    const noCtxSample: Sample = { sample_id: 's', prompt: 'Q?' };
    const r = await runAsyncAssertions(
      'output',
      [{ type: 'faithfulness', reference: 'overridden context' }],
      { executor: judge, judgeModel: 'm', sample: noCtxSample, samplesDir: '.' },
    );
    assert.equal(r.details[0].passed, true);
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

describe('Phase 22.3 — answer_relevancy', () => {
  const sample: Sample = {
    sample_id: 's2',
    prompt: 'How tall is the Eiffel Tower?',
  };

  it('passes when output answers the question', async () => {
    const judge = mockJudge(() => 5);
    const r = await runAsyncAssertions(
      '330 meters tall.',
      [{ type: 'answer_relevancy' }],
      { executor: judge, judgeModel: 'm', sample, samplesDir: '.' },
    );
    assert.equal(r.details[0].passed, true);
  });

  it('fails when output dodges', async () => {
    const judge = mockJudge(() => 1);
    const r = await runAsyncAssertions(
      "Eiffel was an engineer.",
      [{ type: 'answer_relevancy' }],
      { executor: judge, judgeModel: 'm', sample, samplesDir: '.' },
    );
    assert.equal(r.details[0].passed, false);
  });

  it('does not require sample.context', async () => {
    const judge = mockJudge(() => 4);
    const r = await runAsyncAssertions(
      '330m',
      [{ type: 'answer_relevancy' }],
      { executor: judge, judgeModel: 'm', sample, samplesDir: '.' },
    );
    assert.equal(r.details[0].passed, true);
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

describe('Phase 22.3 — context_recall', () => {
  const sample: Sample = {
    sample_id: 's3',
    prompt: 'Summarize.',
    context: 'Key fact A. Key fact B. Key fact C.',
  };

  it('passes when output covers gold facts', async () => {
    const judge = mockJudge(() => 5);
    const r = await runAsyncAssertions(
      'Output covers A B C.',
      [{ type: 'context_recall' }],
      { executor: judge, judgeModel: 'm', sample, samplesDir: '.' },
    );
    assert.equal(r.details[0].passed, true);
  });

  it('fails when output ignores most gold facts', async () => {
    const judge = mockJudge(() => 1);
    const r = await runAsyncAssertions(
      'Only A.',
      [{ type: 'context_recall' }],
      { executor: judge, judgeModel: 'm', sample, samplesDir: '.' },
    );
    assert.equal(r.details[0].passed, false);
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

  it('fails fast when neither reference nor sample.context is present', async () => {
    const judge = mockJudge(() => 5);
    const noCtxSample: Sample = { sample_id: 's', prompt: 'Q?' };
    const r = await runAsyncAssertions(
      'out',
      [{ type: 'context_recall' }],
      { executor: judge, judgeModel: 'm', sample: noCtxSample, samplesDir: '.' },
    );
    assert.equal(r.details[0].passed, false);
    assert.match(r.details[0].message ?? '', /缺少/);
  });
});

describe('Phase 22.3 — judge cost is accumulated', () => {
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
