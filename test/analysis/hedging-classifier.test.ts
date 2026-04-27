import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  classifyHedgingCandidates,
  clearHedgingCache,
  type HedgingCandidate,
} from '../../src/analysis/hedging-classifier.js';
import type { ExecResult, ExecutorFn } from '../../src/types/index.js';

function execOk(output: string, costUSD = 0.001): ExecResult {
  return {
    ok: true,
    output,
    durationMs: 10,
    durationApiMs: 10,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUSD,
    stopReason: 'end_turn',
    numTurns: 1,
  };
}

function execErr(error: string): ExecResult {
  return {
    ok: false,
    output: null,
    error,
    durationMs: 10,
    durationApiMs: 10,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUSD: 0.0001,
    stopReason: 'error',
    numTurns: 0,
  };
}

function makeExecutor(responses: ExecResult[]): { exec: ExecutorFn; calls: number } {
  let i = 0;
  const calls = { n: 0 };
  const exec: ExecutorFn = async () => {
    calls.n += 1;
    if (i >= responses.length) throw new Error('no more mock responses');
    return responses[i++];
  };
  return { exec, get calls() { return calls.n; } } as { exec: ExecutorFn; calls: number };
}

function cand(sampleId: string, sentence: string, context = ''): HedgingCandidate {
  return { sampleId, sentence, context: context || sentence };
}

describe('classifyHedgingCandidates', () => {
  beforeEach(() => clearHedgingCache());

  it('happy path: parses verdicts in order', async () => {
    const response = JSON.stringify([
      { id: 1, isUncertainty: true, confidence: 0.9, reason: 'genuine uncertainty' },
      { id: 2, isUncertainty: false, confidence: 0.8, reason: 'business analysis' },
    ]);
    const m = makeExecutor([execOk(response)]);
    const { verdicts, costUSD } = await classifyHedgingCandidates(
      [cand('s1', '我不确定数据库 schema'), cand('s2', '可能是性能问题或网络问题')],
      m.exec,
    );
    assert.equal(verdicts.length, 2);
    assert.equal(verdicts[0].isUncertainty, true);
    assert.equal(verdicts[1].isUncertainty, false);
    assert.equal(verdicts[0].confidence, 0.9);
    assert.ok(costUSD > 0);
    assert.equal(m.calls, 1);
  });

  it('cache hit: same sentence does not re-call executor', async () => {
    const response = JSON.stringify([
      { id: 1, isUncertainty: true, confidence: 0.85, reason: 'unsure' },
    ]);
    const m = makeExecutor([execOk(response)]);
    const sentence = '需要查证';

    const r1 = await classifyHedgingCandidates([cand('s1', sentence)], m.exec);
    const r2 = await classifyHedgingCandidates([cand('s2', sentence)], m.exec);

    assert.equal(m.calls, 1);
    assert.deepEqual(r1.verdicts[0], r2.verdicts[0]);
    assert.equal(r2.costUSD, 0);
  });

  it('truncation: candidates > maxCandidates flagged truncated and tail falls back', async () => {
    const response = JSON.stringify([
      { id: 1, isUncertainty: true, confidence: 0.8, reason: 'x' },
      { id: 2, isUncertainty: true, confidence: 0.8, reason: 'x' },
    ]);
    const m = makeExecutor([execOk(response)]);
    const { verdicts, truncated } = await classifyHedgingCandidates(
      [cand('s1', 'A'), cand('s2', 'B'), cand('s3', 'C')],
      m.exec,
      { maxCandidates: 2, batchSize: 5 },
    );
    assert.equal(truncated, true);
    assert.equal(verdicts.length, 3);
    assert.equal(verdicts[0].isUncertainty, true);
    assert.equal(verdicts[1].isUncertainty, true);
    // tail: fallback (also isUncertainty=true 保守保留, but reason 标 truncated)
    assert.equal(verdicts[2].isUncertainty, true);
    assert.match(verdicts[2].reason, /truncated/);
  });

  it('exec failure: degrades to isUncertainty=true with classifier failed reason', async () => {
    const m = makeExecutor([execErr('rate limited')]);
    const { verdicts } = await classifyHedgingCandidates(
      [cand('s1', 'A'), cand('s2', 'B')],
      m.exec,
    );
    assert.equal(verdicts.length, 2);
    assert.equal(verdicts[0].isUncertainty, true);
    assert.equal(verdicts[0].confidence, 0);
    assert.match(verdicts[0].reason, /classifier failed/);
  });

  it('parse failure: non-JSON output also degrades', async () => {
    const m = makeExecutor([execOk('Sorry, I could not classify this.')]);
    const { verdicts } = await classifyHedgingCandidates([cand('s1', 'A')], m.exec);
    assert.equal(verdicts[0].isUncertainty, true);
    assert.match(verdicts[0].reason, /classifier failed/);
  });

  it('batch boundary: splits into multiple executor calls when over batchSize', async () => {
    const r1 = JSON.stringify([{ id: 1, isUncertainty: true, confidence: 0.7, reason: 'x' }, { id: 2, isUncertainty: false, confidence: 0.7, reason: 'y' }]);
    const r2 = JSON.stringify([{ id: 1, isUncertainty: true, confidence: 0.7, reason: 'z' }]);
    const m = makeExecutor([execOk(r1, 0.001), execOk(r2, 0.002)]);
    const result = await classifyHedgingCandidates(
      [cand('s1', 'A'), cand('s2', 'B'), cand('s3', 'C')],
      m.exec,
      { batchSize: 2 },
    );
    assert.equal(m.calls, 2);
    assert.equal(result.verdicts.length, 3);
    assert.equal(result.costUSD, 0.003);
  });

  it('empty candidates: no call, returns empty result', async () => {
    const m = makeExecutor([]);
    const result = await classifyHedgingCandidates([], m.exec);
    assert.equal(m.calls, 0);
    assert.equal(result.verdicts.length, 0);
    assert.equal(result.costUSD, 0);
  });
});
