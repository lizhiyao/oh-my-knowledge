import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { clusterFailures, formatFailureClusterReport } from '../../src/analysis/failure-clusterer.js';
import type { ExecutorFn, Report, ResultEntry, VariantResult } from '../../src/types/index.js';

const variantResult = (overrides: Partial<VariantResult> = {}): VariantResult => ({
  ok: true, durationMs: 1000, durationApiMs: 1000,
  inputTokens: 0, outputTokens: 0, totalTokens: 0,
  cacheReadTokens: 0, cacheCreationTokens: 0,
  execCostUSD: 0, judgeCostUSD: 0, costUSD: 0.001, numTurns: 1,
  outputPreview: null,
  ...overrides,
});

const buildReport = (entries: Array<{ id: string; perVariant: Record<string, Partial<VariantResult>> }>, variants: string[]): Report => ({
  id: 'r',
  meta: {
    variants, model: 'm', judgeModel: 'j', executor: 'claude',
    sampleCount: entries.length, taskCount: entries.length, totalCostUSD: 0,
    timestamp: '2026-04-25T00:00:00Z', cliVersion: 'test', nodeVersion: 'test',
    artifactHashes: Object.fromEntries(variants.map((v) => [v, 'h'])),
  },
  summary: {},
  results: entries.map((e) => ({
    sample_id: e.id,
    variants: Object.fromEntries(Object.entries(e.perVariant).map(([v, ovr]) => [v, variantResult(ovr)])),
  } as ResultEntry)),
});

const mockJudge = (response: object): ExecutorFn => async () => ({
  ok: true,
  output: JSON.stringify(response),
  durationMs: 1, durationApiMs: 1,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  costUSD: 0.0001, stopReason: 'end_turn', numTurns: 1,
});

describe('clusterFailures — selection', () => {
  it('returns empty report when there are no failures', async () => {
    const r = buildReport([
      { id: 's1', perVariant: { v1: { compositeScore: 4 } } },
      { id: 's2', perVariant: { v1: { compositeScore: 4.5 } } },
    ], ['v1']);
    const judge = mockJudge({ clusters: [] });
    const out = await clusterFailures({ report: r, executor: judge, judgeModel: 'm' });
    assert.equal(out.totalFailures, 0);
    assert.equal(out.failures.length, 0);
    assert.equal(out.clusters.length, 0);
  });

  it('selects samples with score < threshold', async () => {
    const r = buildReport([
      { id: 'pass', perVariant: { v1: { compositeScore: 4 } } },
      { id: 'fail', perVariant: { v1: { compositeScore: 1.5 } } },
    ], ['v1']);
    const judge = mockJudge({
      clusters: [{
        label: '低分', rootCause: 'demo', suggestedFix: 'demo',
        members: [{ sample_id: 'fail', variant: 'v1' }],
      }],
    });
    const out = await clusterFailures({ report: r, executor: judge, judgeModel: 'm' });
    assert.equal(out.totalFailures, 1);
    assert.equal(out.failures[0].sample_id, 'fail');
  });

  it('selects samples with ok=false even if score is high', async () => {
    const r = buildReport([
      { id: 'errored', perVariant: { v1: { ok: false, compositeScore: 5 } } },
    ], ['v1']);
    const judge = mockJudge({
      clusters: [{
        label: '执行失败', rootCause: 'demo', suggestedFix: 'demo',
        members: [{ sample_id: 'errored', variant: 'v1' }],
      }],
    });
    const out = await clusterFailures({ report: r, executor: judge, judgeModel: 'm' });
    assert.equal(out.totalFailures, 1);
    assert.equal(out.failures[0].errored, true);
  });

  it('truncates when more failures than maxFailuresFed', async () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({
      id: `f${i}`,
      perVariant: { v1: { compositeScore: 1.5 } },
    }));
    const r = buildReport(entries, ['v1']);
    const judge = mockJudge({ clusters: [] });
    const out = await clusterFailures({ report: r, executor: judge, judgeModel: 'm', maxFailuresFed: 50 });
    assert.equal(out.totalFailures, 60);
    assert.equal(out.failures.length, 50);
    assert.equal(out.truncated, true);
  });

  it('emits trivial cluster when only 1 failure (skips LLM call)', async () => {
    const r = buildReport([
      { id: 'lonely', perVariant: { v1: { compositeScore: 1 } } },
    ], ['v1']);
    let called = false;
    const judge: ExecutorFn = async () => {
      called = true;
      return { ok: true, output: '{}', durationMs: 0, durationApiMs: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUSD: 0, stopReason: 'end_turn', numTurns: 0 };
    };
    const out = await clusterFailures({ report: r, executor: judge, judgeModel: 'm' });
    assert.equal(called, false);
    assert.equal(out.clusters.length, 1);
    assert.equal(out.clusters[0].members[0].sample_id, 'lonely');
  });
});

describe('clusterFailures — LLM response handling', () => {
  it('parses a clean JSON cluster response', async () => {
    const r = buildReport([
      { id: 'a', perVariant: { v1: { compositeScore: 1 } } },
      { id: 'b', perVariant: { v1: { compositeScore: 1.5 } } },
      { id: 'c', perVariant: { v1: { compositeScore: 2 } } },
    ], ['v1']);
    const judge = mockJudge({
      clusters: [
        {
          label: '工具调用错', rootCause: '调用失败', suggestedFix: '加超时',
          members: [{ sample_id: 'a', variant: 'v1' }, { sample_id: 'b', variant: 'v1' }],
        },
        {
          label: '格式错', rootCause: '不符合 schema', suggestedFix: '加 JSON 校验',
          members: [{ sample_id: 'c', variant: 'v1' }],
        },
      ],
    });
    const out = await clusterFailures({ report: r, executor: judge, judgeModel: 'm' });
    // sorted by member count desc
    assert.equal(out.clusters[0].label, '工具调用错');
    assert.equal(out.clusters[0].members.length, 2);
    assert.equal(out.clusters[1].label, '格式错');
  });

  it('drops hallucinated members not in the fed list', async () => {
    const r = buildReport([
      { id: 'real', perVariant: { v1: { compositeScore: 1 } } },
      { id: 'real2', perVariant: { v1: { compositeScore: 1 } } },
    ], ['v1']);
    const judge = mockJudge({
      clusters: [{
        label: 'L', rootCause: 'r', suggestedFix: 'f',
        members: [
          { sample_id: 'real', variant: 'v1' },
          { sample_id: 'fabricated', variant: 'v1' },
          { sample_id: 'real2', variant: 'v1' },
        ],
      }],
    });
    const out = await clusterFailures({ report: r, executor: judge, judgeModel: 'm' });
    assert.equal(out.clusters[0].members.length, 2);
    assert.ok(!out.clusters[0].members.some((m) => m.sample_id === 'fabricated'));
  });

  it('lists failures as unclassified when LLM produces no clusters', async () => {
    const r = buildReport([
      { id: 'a', perVariant: { v1: { compositeScore: 1 } } },
      { id: 'b', perVariant: { v1: { compositeScore: 1 } } },
    ], ['v1']);
    const judge = mockJudge({ clusters: [] });
    const out = await clusterFailures({ report: r, executor: judge, judgeModel: 'm' });
    assert.equal(out.clusters.length, 0);
    assert.equal(out.unclassified.length, 2);
  });

  it('tolerates ```json``` markdown fence in response', async () => {
    const r = buildReport([
      { id: 'a', perVariant: { v1: { compositeScore: 1 } } },
      { id: 'b', perVariant: { v1: { compositeScore: 1 } } },
    ], ['v1']);
    const judge: ExecutorFn = async () => ({
      ok: true,
      output: '```json\n{ "clusters": [{ "label": "L", "rootCause": "r", "suggestedFix": "f", "members": [{"sample_id":"a","variant":"v1"},{"sample_id":"b","variant":"v1"}] }] }\n```',
      durationMs: 1, durationApiMs: 1,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUSD: 0.0001, stopReason: 'end_turn', numTurns: 1,
    });
    const out = await clusterFailures({ report: r, executor: judge, judgeModel: 'm' });
    assert.equal(out.clusters.length, 1);
    assert.equal(out.clusters[0].members.length, 2);
  });

  it('tolerates "sample_id@variant" string member form', async () => {
    const r = buildReport([
      { id: 'a', perVariant: { v1: { compositeScore: 1 } } },
      { id: 'b', perVariant: { v1: { compositeScore: 1 } } },
    ], ['v1']);
    const judge = mockJudge({
      clusters: [{
        label: 'L', rootCause: 'r', suggestedFix: 'f',
        members: ['a@v1', 'b@v1'],
      }],
    });
    const out = await clusterFailures({ report: r, executor: judge, judgeModel: 'm' });
    assert.equal(out.clusters[0].members.length, 2);
  });

  it('handles executor error gracefully', async () => {
    const r = buildReport([
      { id: 'a', perVariant: { v1: { compositeScore: 1 } } },
      { id: 'b', perVariant: { v1: { compositeScore: 1 } } },
    ], ['v1']);
    const judge: ExecutorFn = async () => ({
      ok: false, output: null, durationMs: 0, durationApiMs: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUSD: 0.0001, stopReason: 'error', numTurns: 0, error: 'mock error',
    });
    const out = await clusterFailures({ report: r, executor: judge, judgeModel: 'm' });
    assert.equal(out.clusters.length, 0);
    assert.equal(out.unclassified.length, 2);
    assert.ok(out.clusterCostUSD > 0);
  });
});

describe('formatFailureClusterReport', () => {
  it('prints cluster labels and root causes', async () => {
    const r = buildReport([
      { id: 'a', perVariant: { v1: { compositeScore: 1 } } },
      { id: 'b', perVariant: { v1: { compositeScore: 1 } } },
    ], ['v1']);
    const judge = mockJudge({
      clusters: [{
        label: '工具调用错', rootCause: '超时', suggestedFix: '加重试',
        members: [{ sample_id: 'a', variant: 'v1' }, { sample_id: 'b', variant: 'v1' }],
      }],
    });
    const out = await clusterFailures({ report: r, executor: judge, judgeModel: 'm' });
    const text = formatFailureClusterReport(out);
    assert.match(text, /\[工具调用错\] 2 条/);
    assert.match(text, /根因: 超时/);
    assert.match(text, /建议: 加重试/);
  });

  it('emits "聚类失败" message when no clusters were produced', async () => {
    const r = buildReport([
      { id: 'a', perVariant: { v1: { compositeScore: 1 } } },
      { id: 'b', perVariant: { v1: { compositeScore: 1 } } },
    ], ['v1']);
    const judge = mockJudge({ clusters: [] });
    const out = await clusterFailures({ report: r, executor: judge, judgeModel: 'm' });
    const text = formatFailureClusterReport(out);
    assert.match(text, /聚类失败/);
  });
});
