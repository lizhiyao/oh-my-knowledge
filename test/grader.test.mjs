import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAssertions, grade } from '../lib/grader.mjs';

describe('runAssertions', () => {
  it('contains: passes when substring is present', () => {
    const result = runAssertions('This has SQL injection risk', [
      { type: 'contains', value: 'SQL', weight: 1 },
    ]);
    assert.equal(result.passed, 1);
    assert.equal(result.total, 1);
    assert.equal(result.score, 5); // 100% → 1 + 1*4 = 5
  });

  it('contains: case insensitive', () => {
    const result = runAssertions('sql injection detected', [
      { type: 'contains', value: 'SQL', weight: 1 },
    ]);
    assert.equal(result.passed, 1);
  });

  it('contains: fails when substring is absent', () => {
    const result = runAssertions('Everything looks good', [
      { type: 'contains', value: 'SQL', weight: 1 },
    ]);
    assert.equal(result.passed, 0);
    assert.equal(result.score, 1); // 0% → 1 + 0*4 = 1
  });

  it('not_contains: passes when substring is absent', () => {
    const result = runAssertions('Found SQL injection', [
      { type: 'not_contains', value: 'looks good', weight: 1 },
    ]);
    assert.equal(result.passed, 1);
  });

  it('not_contains: fails when substring is present', () => {
    const result = runAssertions('Everything looks good', [
      { type: 'not_contains', value: 'looks good', weight: 1 },
    ]);
    assert.equal(result.passed, 0);
  });

  it('regex: matches pattern', () => {
    const result = runAssertions('Use try { } catch(e) { }', [
      { type: 'regex', pattern: 'try[\\s\\S]*catch', flags: 'i', weight: 1 },
    ]);
    assert.equal(result.passed, 1);
  });

  it('regex: fails when no match', () => {
    const result = runAssertions('No error handling here', [
      { type: 'regex', pattern: 'try[\\s\\S]*catch', flags: 'i', weight: 1 },
    ]);
    assert.equal(result.passed, 0);
  });

  it('min_length: passes when long enough', () => {
    const result = runAssertions('A'.repeat(100), [
      { type: 'min_length', value: 50, weight: 1 },
    ]);
    assert.equal(result.passed, 1);
  });

  it('min_length: fails when too short', () => {
    const result = runAssertions('Short', [
      { type: 'min_length', value: 50, weight: 1 },
    ]);
    assert.equal(result.passed, 0);
  });

  it('max_length: passes when short enough', () => {
    const result = runAssertions('Short', [
      { type: 'max_length', value: 50, weight: 1 },
    ]);
    assert.equal(result.passed, 1);
  });

  it('max_length: fails when too long', () => {
    const result = runAssertions('A'.repeat(100), [
      { type: 'max_length', value: 50, weight: 1 },
    ]);
    assert.equal(result.passed, 0);
  });

  it('weighted scoring: partial pass', () => {
    const result = runAssertions('Found SQL injection vulnerability', [
      { type: 'contains', value: 'SQL', weight: 1 },
      { type: 'contains', value: 'injection', weight: 1 },
      { type: 'contains', value: 'parameterized', weight: 0.5 }, // fails
      { type: 'not_contains', value: 'looks good', weight: 0.5 }, // passes
    ]);
    assert.equal(result.passed, 3);
    assert.equal(result.total, 4);
    // passedWeight = 1+1+0.5 = 2.5, totalWeight = 3.0, ratio = 0.833
    // score = 1 + 0.833*4 = 4.33
    assert.ok(result.score > 4 && result.score < 4.5);
  });

  it('unknown assertion type: treated as failed', () => {
    const result = runAssertions('Hello', [
      { type: 'unknown_type', value: 'test', weight: 1 },
    ]);
    assert.equal(result.passed, 0);
    assert.equal(result.details[0].passed, false);
  });

  it('default weight is 1', () => {
    const result = runAssertions('Hello world', [
      { type: 'contains', value: 'Hello' },
    ]);
    assert.equal(result.details[0].weight, 1);
  });
});

describe('grade', () => {
  it('assertions only: no LLM call needed', async () => {
    const result = await grade({
      output: 'Found SQL injection, use parameterized queries',
      sample: {
        prompt: 'Review code',
        assertions: [
          { type: 'contains', value: 'SQL', weight: 1 },
          { type: 'contains', value: 'parameterized', weight: 1 },
        ],
      },
      executor: null, // no LLM calls
      judgeModel: 'haiku',
    });
    assert.equal(result.assertions.passed, 2);
    assert.equal(result.compositeScore, 5);
    assert.equal(result.llmScore, undefined);
  });

  it('rubric only: calls LLM judge', async () => {
    const mockExecutor = async () => ({
      ok: true,
      output: '{"score": 4, "reason": "Good review"}',
      costUSD: 0.001,
    });

    const result = await grade({
      output: 'Found vulnerability',
      sample: {
        prompt: 'Review code',
        rubric: 'Should find SQL injection',
      },
      executor: mockExecutor,
      judgeModel: 'haiku',
    });
    assert.equal(result.llmScore, 4);
    assert.equal(result.llmReason, 'Good review');
    assert.equal(result.compositeScore, 4);
  });

  it('both assertions and rubric: composite score', async () => {
    const mockExecutor = async () => ({
      ok: true,
      output: '{"score": 4, "reason": "Good"}',
      costUSD: 0.001,
    });

    const result = await grade({
      output: 'SQL injection found, use parameterized queries',
      sample: {
        prompt: 'Review code',
        rubric: 'Should find SQL injection',
        assertions: [
          { type: 'contains', value: 'SQL', weight: 1 },
          { type: 'contains', value: 'parameterized', weight: 1 },
        ],
      },
      executor: mockExecutor,
      judgeModel: 'haiku',
    });
    assert.equal(result.assertions.passed, 2);
    assert.equal(result.llmScore, 4);
    // composite = (5 + 4) / 2 = 4.5
    assert.equal(result.compositeScore, 4.5);
  });

  it('dimensions: multi-dimensional scoring', async () => {
    let callCount = 0;
    const mockExecutor = async () => {
      callCount++;
      const score = callCount === 1 ? 5 : 3;
      return {
        ok: true,
        output: `{"score": ${score}, "reason": "dim ${callCount}"}`,
        costUSD: 0.001,
      };
    };

    const result = await grade({
      output: 'SQL injection found',
      sample: {
        prompt: 'Review code',
        dimensions: {
          security: 'Identify SQL injection',
          actionability: 'Provide fix code',
        },
      },
      executor: mockExecutor,
      judgeModel: 'haiku',
    });
    assert.equal(result.dimensions.security.score, 5);
    assert.equal(result.dimensions.actionability.score, 3);
    assert.equal(result.llmScore, 4); // (5+3)/2
    assert.equal(result.compositeScore, 4);
  });

  it('no criteria: score is 0', async () => {
    const result = await grade({
      output: 'Some output',
      sample: { prompt: 'Do something' },
      executor: null,
      judgeModel: 'haiku',
    });
    assert.equal(result.compositeScore, 0);
  });
});
