import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAssertions, grade, validateJsonSchema } from '../lib/grader.js';
import type { ExecResult } from '../lib/types.js';

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

  // --- New assertion types (F4) ---

  it('json_valid: passes for valid JSON', () => {
    const result = runAssertions('{"key": "value"}', [
      { type: 'json_valid', weight: 1 },
    ]);
    assert.equal(result.passed, 1);
  });

  it('json_valid: fails for invalid JSON', () => {
    const result = runAssertions('not json', [
      { type: 'json_valid', weight: 1 },
    ]);
    assert.equal(result.passed, 0);
  });

  it('json_schema: passes when data matches schema', () => {
    const result = runAssertions('{"name": "Alice", "age": 30}', [
      {
        type: 'json_schema',
        schema: {
          type: 'object',
          required: ['name', 'age'],
          properties: {
            name: { type: 'string' },
            age: { type: 'number', minimum: 0 },
          },
        },
        weight: 1,
      },
    ]);
    assert.equal(result.passed, 1);
  });

  it('json_schema: fails when data does not match schema', () => {
    const result = runAssertions('{"name": 123}', [
      {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
        weight: 1,
      },
    ]);
    assert.equal(result.passed, 0);
  });

  it('starts_with: case insensitive', () => {
    const result = runAssertions('Hello World', [
      { type: 'starts_with', value: 'hello', weight: 1 },
    ]);
    assert.equal(result.passed, 1);
  });

  it('starts_with: fails when not matching', () => {
    const result = runAssertions('World Hello', [
      { type: 'starts_with', value: 'hello', weight: 1 },
    ]);
    assert.equal(result.passed, 0);
  });

  it('ends_with: case insensitive', () => {
    const result = runAssertions('Hello World', [
      { type: 'ends_with', value: 'world', weight: 1 },
    ]);
    assert.equal(result.passed, 1);
  });

  it('equals: exact match after trim', () => {
    const result = runAssertions('  hello  ', [
      { type: 'equals', value: 'hello', weight: 1 },
    ]);
    assert.equal(result.passed, 1);
  });

  it('equals: fails on mismatch', () => {
    const result = runAssertions('hello world', [
      { type: 'equals', value: 'hello', weight: 1 },
    ]);
    assert.equal(result.passed, 0);
  });

  it('not_equals: passes on mismatch', () => {
    const result = runAssertions('hello world', [
      { type: 'not_equals', value: 'hello', weight: 1 },
    ]);
    assert.equal(result.passed, 1);
  });

  it('word_count_min: passes when enough words', () => {
    const result = runAssertions('one two three four five', [
      { type: 'word_count_min', value: 3, weight: 1 },
    ]);
    assert.equal(result.passed, 1);
  });

  it('word_count_min: fails when too few words', () => {
    const result = runAssertions('one two', [
      { type: 'word_count_min', value: 3, weight: 1 },
    ]);
    assert.equal(result.passed, 0);
  });

  it('word_count_max: passes when few enough words', () => {
    const result = runAssertions('one two', [
      { type: 'word_count_max', value: 3, weight: 1 },
    ]);
    assert.equal(result.passed, 1);
  });

  it('word_count_max: fails when too many words', () => {
    const result = runAssertions('one two three four', [
      { type: 'word_count_max', value: 3, weight: 1 },
    ]);
    assert.equal(result.passed, 0);
  });

  it('contains_all: passes when all values present', () => {
    const result = runAssertions('SQL injection XSS vulnerability', [
      { type: 'contains_all', values: ['SQL', 'XSS'], weight: 1 },
    ]);
    assert.equal(result.passed, 1);
  });

  it('contains_all: fails when one value missing', () => {
    const result = runAssertions('SQL injection found', [
      { type: 'contains_all', values: ['SQL', 'XSS'], weight: 1 },
    ]);
    assert.equal(result.passed, 0);
  });

  it('contains_any: passes when at least one value present', () => {
    const result = runAssertions('SQL injection found', [
      { type: 'contains_any', values: ['SQL', 'XSS'], weight: 1 },
    ]);
    assert.equal(result.passed, 1);
  });

  it('contains_any: fails when no values present', () => {
    const result = runAssertions('Everything is fine', [
      { type: 'contains_any', values: ['SQL', 'XSS'], weight: 1 },
    ]);
    assert.equal(result.passed, 0);
  });

  it('cost_max: passes when cost within budget', () => {
    const result = runAssertions('output', [
      { type: 'cost_max', value: 0.01, weight: 1 },
    ], { costUSD: 0.005 });
    assert.equal(result.passed, 1);
  });

  it('cost_max: fails when cost exceeds budget', () => {
    const result = runAssertions('output', [
      { type: 'cost_max', value: 0.01, weight: 1 },
    ], { costUSD: 0.02 });
    assert.equal(result.passed, 0);
  });

  it('latency_max: passes when fast enough', () => {
    const result = runAssertions('output', [
      { type: 'latency_max', value: 5000, weight: 1 },
    ], { durationMs: 3000 });
    assert.equal(result.passed, 1);
  });

  it('latency_max: fails when too slow', () => {
    const result = runAssertions('output', [
      { type: 'latency_max', value: 5000, weight: 1 },
    ], { durationMs: 8000 });
    assert.equal(result.passed, 0);
  });
});

describe('validateJsonSchema', () => {
  it('validates type: string', () => {
    assert.equal(validateJsonSchema('hello', { type: 'string' }), true);
    assert.equal(validateJsonSchema(123, { type: 'string' }), false);
  });

  it('validates type: integer', () => {
    assert.equal(validateJsonSchema(42, { type: 'integer' }), true);
    assert.equal(validateJsonSchema(3.14, { type: 'integer' }), false);
  });

  it('validates required fields', () => {
    assert.equal(validateJsonSchema({ a: 1, b: 2 }, { type: 'object', required: ['a', 'b'] }), true);
    assert.equal(validateJsonSchema({ a: 1 }, { type: 'object', required: ['a', 'b'] }), false);
  });

  it('validates array items', () => {
    assert.equal(validateJsonSchema([1, 2, 3], { type: 'array', items: { type: 'number' } }), true);
    assert.equal(validateJsonSchema([1, 'two'], { type: 'array', items: { type: 'number' } }), false);
  });

  it('validates enum', () => {
    assert.equal(validateJsonSchema('a', { enum: ['a', 'b'] }), true);
    assert.equal(validateJsonSchema('c', { enum: ['a', 'b'] }), false);
  });

  it('validates string constraints', () => {
    assert.equal(validateJsonSchema('abc', { type: 'string', minLength: 2, maxLength: 5 }), true);
    assert.equal(validateJsonSchema('a', { type: 'string', minLength: 2 }), false);
    assert.equal(validateJsonSchema('abcdef', { type: 'string', maxLength: 5 }), false);
  });

  it('validates number constraints', () => {
    assert.equal(validateJsonSchema(5, { type: 'number', minimum: 1, maximum: 10 }), true);
    assert.equal(validateJsonSchema(0, { type: 'number', minimum: 1 }), false);
  });
});

describe('grade', () => {
  it('assertions only: no LLM call needed', async () => {
    const result = await grade({
      output: 'Found SQL injection, use parameterized queries',
      sample: {
        sample_id: 'test',
        prompt: 'Review code',
        assertions: [
          { type: 'contains', value: 'SQL', weight: 1 },
          { type: 'contains', value: 'parameterized', weight: 1 },
        ],
      },
      executor: null as any, // no LLM calls
      judgeModel: 'haiku',
    });
    assert.equal(result.assertions!.passed, 2);
    assert.equal(result.compositeScore, 5);
    assert.equal(result.llmScore, undefined);
  });

  it('rubric only: calls LLM judge', async () => {
    const mockExecutor = async (): Promise<ExecResult> => ({
      ok: true,
      output: '{"score": 4, "reason": "Good review"}',
      costUSD: 0.001,
      durationMs: 0,
      durationApiMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      stopReason: 'end_turn',
      numTurns: 1,
    });

    const result = await grade({
      output: 'Found vulnerability',
      sample: {
        sample_id: 'test',
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
    const mockExecutor = async (): Promise<ExecResult> => ({
      ok: true,
      output: '{"score": 4, "reason": "Good"}',
      costUSD: 0.001,
      durationMs: 0,
      durationApiMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      stopReason: 'end_turn',
      numTurns: 1,
    });

    const result = await grade({
      output: 'SQL injection found, use parameterized queries',
      sample: {
        sample_id: 'test',
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
    assert.equal(result.assertions!.passed, 2);
    assert.equal(result.llmScore, 4);
    // composite = (5 + 4) / 2 = 4.5
    assert.equal(result.compositeScore, 4.5);
  });

  it('dimensions: multi-dimensional scoring', async () => {
    let callCount = 0;
    const mockExecutor = async (): Promise<ExecResult> => {
      callCount++;
      const score = callCount === 1 ? 5 : 3;
      return {
        ok: true,
        output: `{"score": ${score}, "reason": "dim ${callCount}"}`,
        costUSD: 0.001,
        durationMs: 0,
        durationApiMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        stopReason: 'end_turn',
        numTurns: 1,
      };
    };

    const result = await grade({
      output: 'SQL injection found',
      sample: {
        sample_id: 'test',
        prompt: 'Review code',
        dimensions: {
          security: 'Identify SQL injection',
          actionability: 'Provide fix code',
        },
      },
      executor: mockExecutor,
      judgeModel: 'haiku',
    });
    assert.equal(result.dimensions!.security.score, 5);
    assert.equal(result.dimensions!.actionability.score, 3);
    assert.equal(result.llmScore, 4); // (5+3)/2
    assert.equal(result.compositeScore, 4);
  });

  it('no criteria: score is 0', async () => {
    const result = await grade({
      output: 'Some output',
      sample: { sample_id: 'test', prompt: 'Do something' },
      executor: null as any,
      judgeModel: 'haiku',
    });
    assert.equal(result.compositeScore, 0);
  });

  it('custom assertion: calls external JS function', async () => {
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const __dirname = dirname(fileURLToPath(import.meta.url));

    const result = await grade({
      output: 'Found SQL injection and SQL bypass',
      sample: {
        sample_id: 'test',
        prompt: 'Review code',
        assertions: [
          { type: 'custom', fn: 'fixtures/custom-assertion.mjs', keyword: 'SQL', minCount: 2, weight: 1 } as Record<string, unknown> & { type: string; weight: number },
        ],
      },
      executor: async (): Promise<ExecResult> => ({ ok: true, output: '{}', costUSD: 0, durationMs: 0, durationApiMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, stopReason: 'end_turn', numTurns: 1 }),
      judgeModel: 'haiku',
      samplesDir: join(__dirname, '..', '..', 'test'),
    });
    assert.equal(result.assertions!.passed, 1);
    assert.equal(result.assertions!.details[0].passed, true);
  });

  it('semantic_similarity: uses LLM judge', async () => {
    const mockExecutor = async (): Promise<ExecResult> => ({
      ok: true,
      output: '{"score": 4, "reason": "Very similar"}',
      costUSD: 0.001,
      durationMs: 0,
      durationApiMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      stopReason: 'end_turn',
      numTurns: 1,
    });

    const result = await grade({
      output: 'SQL injection vulnerability found',
      sample: {
        sample_id: 'test',
        prompt: 'Review code',
        assertions: [
          { type: 'semantic_similarity', reference: 'SQL injection detected', threshold: 3, weight: 1 },
        ],
      },
      executor: mockExecutor,
      judgeModel: 'haiku',
    });
    assert.equal(result.assertions!.passed, 1);
    assert.equal(result.assertions!.details[0].passed, true);
  });

  it('mixed sync + async assertions: merged correctly', async () => {
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const __dirname = dirname(fileURLToPath(import.meta.url));

    const result = await grade({
      output: 'SQL injection found, use parameterized queries',
      sample: {
        sample_id: 'test',
        prompt: 'Review code',
        assertions: [
          { type: 'contains', value: 'SQL', weight: 1 },
          { type: 'custom', fn: 'fixtures/custom-assertion.mjs', keyword: 'SQL', minCount: 1, weight: 1 } as Record<string, unknown> & { type: string; weight: number },
        ],
      },
      executor: async (): Promise<ExecResult> => ({ ok: true, output: '{}', costUSD: 0, durationMs: 0, durationApiMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, stopReason: 'end_turn', numTurns: 1 }),
      judgeModel: 'haiku',
      samplesDir: join(__dirname, '..', '..', 'test'),
    });
    assert.equal(result.assertions!.passed, 2);
    assert.equal(result.assertions!.total, 2);
    assert.equal(result.assertions!.score, 5); // both pass
  });
});

describe('grade cost accumulation', () => {
  it('accumulates dimensions judge cost', async () => {
    let callCount = 0;
    const mockExecutor = async (): Promise<ExecResult> => {
      callCount++;
      return {
        ok: true,
        output: `{"score": ${callCount + 2}, "reason": "dim ${callCount}"}`,
        costUSD: 0.01,
        durationMs: 0,
        durationApiMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        stopReason: 'end_turn',
        numTurns: 1,
      };
    };

    const result = await grade({
      output: 'Found SQL injection',
      sample: {
        sample_id: 'test',
        prompt: 'Review code',
        dimensions: {
          security: 'Check security',
          perf: 'Check performance',
        },
      },
      executor: mockExecutor,
      judgeModel: 'haiku',
    });
    // 2 dimensions × $0.01 each = $0.02
    assert.equal(result.judgeCostUSD, 0.02);
  });

  it('accumulates rubric judge cost', async () => {
    const mockExecutor = async (): Promise<ExecResult> => ({
      ok: true,
      output: '{"score": 4, "reason": "Good"}',
      costUSD: 0.005,
      durationMs: 0,
      durationApiMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      stopReason: 'end_turn',
      numTurns: 1,
    });

    const result = await grade({
      output: 'Found issue',
      sample: { sample_id: 'test', prompt: 'Review', rubric: 'Find bugs' },
      executor: mockExecutor,
      judgeModel: 'haiku',
    });
    assert.equal(result.judgeCostUSD, 0.005);
  });

  it('accumulates async assertion cost + dimensions cost', async () => {
    const mockExecutor = async (): Promise<ExecResult> => {
      return {
        ok: true,
        output: `{"score": 4, "reason": "ok"}`,
        costUSD: 0.01,
        durationMs: 0,
        durationApiMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        stopReason: 'end_turn',
        numTurns: 1,
      };
    };

    const result = await grade({
      output: 'SQL injection found',
      sample: {
        sample_id: 'test',
        prompt: 'Review',
        assertions: [
          { type: 'semantic_similarity', reference: 'SQL injection', threshold: 3, weight: 1 },
        ],
        dimensions: {
          security: 'Check security',
        },
      },
      executor: mockExecutor,
      judgeModel: 'haiku',
    });
    // 1 semantic_similarity ($0.01) + 1 dimension ($0.01) = $0.02
    assert.equal(result.judgeCostUSD, 0.02);
  });
});
