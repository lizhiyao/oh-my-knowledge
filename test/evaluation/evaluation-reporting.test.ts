import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { aggregateReport } from '../../src/eval-core/evaluation-reporting.js';
import type { Artifact, Sample, Task, VariantResult, EvaluationRequest } from '../../src/types.js';

function makeArtifact(name: string, content: string): Artifact {
  return { name, kind: 'skill', source: 'inline', content, experimentRole: 'treatment' };
}

function makeSample(id: string, prompt: string, rubric?: string): Sample {
  const s: Sample = { sample_id: id, prompt };
  if (rubric) s.rubric = rubric;
  return s;
}

function makeVariantResult(): VariantResult {
  return {
    ok: true,
    durationMs: 100, durationApiMs: 100,
    inputTokens: 100, outputTokens: 50, totalTokens: 150,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    execCostUSD: 0.001, judgeCostUSD: 0, costUSD: 0.001,
    numTurns: 1, outputPreview: 'ok',
  };
}

describe('aggregateReport — reproducibility metadata', () => {
  const baseOpts = {
    runId: 'run-1',
    variants: ['v1'],
    model: 'haiku',
    judgeModel: 'haiku',
    noJudge: false,
    executorName: 'claude',
    samples: [makeSample('s1', 'task one', 'rubric one'), makeSample('s2', 'task two')],
    tasks: [] as Task[],
    results: { s1: { v1: makeVariantResult() }, s2: { v1: makeVariantResult() } },
    totalCostUSD: 0.002,
    artifacts: [makeArtifact('v1', 'skill content')],
  };

  it('writes sampleHashes — one entry per sample, 12-char hex hashes', () => {
    const report = aggregateReport(baseOpts);
    assert.ok(report.meta.sampleHashes, 'sampleHashes should be present');
    const ids = Object.keys(report.meta.sampleHashes!);
    assert.deepEqual(ids.sort(), ['s1', 's2']);
    for (const hash of Object.values(report.meta.sampleHashes!)) {
      assert.match(hash, /^[0-9a-f]{12}$/);
    }
    // Different content → different hashes
    assert.notEqual(report.meta.sampleHashes!.s1, report.meta.sampleHashes!.s2);
  });

  it('sampleHashes is stable: same sample content → same hash across calls', () => {
    const r1 = aggregateReport(baseOpts);
    const r2 = aggregateReport(baseOpts);
    assert.equal(r1.meta.sampleHashes!.s1, r2.meta.sampleHashes!.s1);
    assert.equal(r1.meta.sampleHashes!.s2, r2.meta.sampleHashes!.s2);
  });

  it('writes judgePromptHash when noJudge=false', () => {
    const report = aggregateReport(baseOpts);
    assert.ok(report.meta.judgePromptHash, 'judgePromptHash should be set');
    assert.match(report.meta.judgePromptHash!, /^[0-9a-f]{12}$/);
  });

  it('omits judgePromptHash when noJudge=true (no judge ran)', () => {
    const report = aggregateReport({ ...baseOpts, noJudge: true });
    assert.equal(report.meta.judgePromptHash, undefined);
  });

  it('writes judgeRepeat when request.judgeRepeat > 1', () => {
    const request: EvaluationRequest = {
      samplesPath: '/tmp/s.json', skillDir: '/tmp', artifacts: [], model: 'haiku', judgeModel: 'haiku',
      executor: 'claude', noJudge: false, concurrency: 1, noCache: false, dryRun: false, blind: false,
      judgeRepeat: 3,
    };
    const report = aggregateReport({ ...baseOpts, request });
    assert.equal(report.meta.judgeRepeat, 3);
  });

  it('omits judgeRepeat when request.judgeRepeat is 1 or unset (avoid noise)', () => {
    const request1: EvaluationRequest = {
      samplesPath: '/tmp/s.json', skillDir: '/tmp', artifacts: [], model: 'haiku', judgeModel: 'haiku',
      executor: 'claude', noJudge: false, concurrency: 1, noCache: false, dryRun: false, blind: false,
      judgeRepeat: 1,
    };
    const r1 = aggregateReport({ ...baseOpts, request: request1 });
    assert.equal(r1.meta.judgeRepeat, undefined);

    const r2 = aggregateReport(baseOpts); // no request at all
    assert.equal(r2.meta.judgeRepeat, undefined);
  });
});

describe('aggregateReport — sampleHash key-order stability', () => {
  // The whole point of canonical JSON: key insertion order shouldn't affect hash.
  // Two samples with the same dimensions but different key insertion order must hash equal.
  function commonOpts(samples: Sample[]) {
    return {
      runId: 'r', variants: ['v1'], model: 'haiku', judgeModel: 'haiku', noJudge: false,
      executorName: 'claude',
      samples,
      tasks: [] as Task[],
      results: Object.fromEntries(samples.map((s) => [s.sample_id, { v1: makeVariantResult() }])),
      totalCostUSD: 0,
      artifacts: [makeArtifact('v1', 'c')],
    };
  }

  it('different dimensions key insertion order → same hash', () => {
    const a: Sample = { sample_id: 'a', prompt: 'p', dimensions: { correctness: 'r1', clarity: 'r2' } };
    // Build via a different path so JS engine may iterate keys in a different order
    const dims: Record<string, string> = {};
    dims.clarity = 'r2';
    dims.correctness = 'r1';
    const b: Sample = { sample_id: 'b', prompt: 'p', dimensions: dims };
    const r = aggregateReport(commonOpts([a, b]));
    assert.equal(r.meta.sampleHashes!.a, r.meta.sampleHashes!.b);
  });

  it('different assertions array order → DIFFERENT hash (order is meaningful)', () => {
    // Arrays, unlike object keys, have semantic order — assertion order may matter
    // for evaluation pipelines (e.g. early-exit). Hash should reflect that.
    const a: Sample = {
      sample_id: 'a', prompt: 'p',
      assertions: [{ type: 'contains', value: 'foo', weight: 1 }, { type: 'contains', value: 'bar', weight: 1 }],
    };
    const b: Sample = {
      sample_id: 'b', prompt: 'p',
      assertions: [{ type: 'contains', value: 'bar', weight: 1 }, { type: 'contains', value: 'foo', weight: 1 }],
    };
    const r = aggregateReport(commonOpts([a, b]));
    assert.notEqual(r.meta.sampleHashes!.a, r.meta.sampleHashes!.b);
  });

  it('same prompt + different rubric → different hash', () => {
    const a: Sample = { sample_id: 'a', prompt: 'p', rubric: 'rubric one' };
    const b: Sample = { sample_id: 'b', prompt: 'p', rubric: 'rubric two' };
    const r = aggregateReport(commonOpts([a, b]));
    assert.notEqual(r.meta.sampleHashes!.a, r.meta.sampleHashes!.b);
  });

  it('same prompt + different dimensions → different hash', () => {
    const a: Sample = { sample_id: 'a', prompt: 'p', dimensions: { acc: 'is it accurate' } };
    const b: Sample = { sample_id: 'b', prompt: 'p', dimensions: { acc: 'is it accurate', clarity: 'is it clear' } };
    const r = aggregateReport(commonOpts([a, b]));
    assert.notEqual(r.meta.sampleHashes!.a, r.meta.sampleHashes!.b);
  });
});
