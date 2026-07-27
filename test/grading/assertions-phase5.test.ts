import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { runAssertions, rougeN, levenshtein, bleu } from '../../src/grading/assertions.js';
import type { Assertion } from '../../src/types/index.js';

describe('mock_hit assertion', () => {
  const mockStats = { hits: 4, misses: 1, perMock: { 'Bash:1': 1, 'Bash:2': 2, 'Read:1': 1 } };

  it('passes when mock hit count >= 1 (default threshold)', () => {
    const r = runAssertions('out', [{ type: 'mock_hit', value: 'Bash:1' }], { mockStats });
    assert.equal(r.details[0].passed, true);
  });

  it('passes when count meets explicit threshold', () => {
    const r = runAssertions('out', [{ type: 'mock_hit', value: 'Bash:2', threshold: 2 }], { mockStats });
    assert.equal(r.details[0].passed, true);
  });

  it('fails when count below threshold', () => {
    const r = runAssertions('out', [{ type: 'mock_hit', value: 'Bash:1', threshold: 5 }], { mockStats });
    assert.equal(r.details[0].passed, false);
  });

  it('fails when mock key never hit (not in perMock map)', () => {
    const r = runAssertions('out', [{ type: 'mock_hit', value: 'Bash:99' }], { mockStats });
    assert.equal(r.details[0].passed, false);
  });

  it('fails when no mockStats provided in context', () => {
    const r = runAssertions('out', [{ type: 'mock_hit', value: 'Bash:1' }]);
    assert.equal(r.details[0].passed, false);
  });

  it('respects not: true inversion', () => {
    const r = runAssertions('out', [{ type: 'mock_hit', value: 'Bash:99', not: true }], { mockStats });
    assert.equal(r.details[0].passed, true);
  });
});

describe('universal `not: true` field', () => {
  it('covers top-level not inversion behavior', () => {
    const r = runAssertions('hello world', [
      { type: 'contains', value: 'foo' },                  // raw fail
      { type: 'contains', value: 'foo', not: true },       // inverted → pass
      { type: 'contains', value: 'hello' },                 // raw pass
      { type: 'contains', value: 'hello', not: true },      // inverted → fail
    ]);
    assert.deepEqual(r.details.map((d) => d.passed), [false, true, true, false]);
  });

  it('not: true is equivalent to not_contains for the contains case', () => {
    const a = runAssertions('hello', [{ type: 'contains', value: 'world', not: true }]);
    const b = runAssertions('hello', [{ type: 'not_contains', value: 'world' }]);
    assert.equal(a.details[0].passed, b.details[0].passed);

    const regex = runAssertions('output 42', [
      { type: 'regex', pattern: '\\d+', not: true },
    ]);
    assert.equal(regex.details[0].passed, false);
  });
});

describe('assert-set combinator', () => {
  const cases: Array<{ name: string; output: string; assertion: Assertion; expected: boolean }> = [
    {
      name: "'all' mode requires every child to pass",
      output: 'hello world',
      assertion: {
        type: 'assert-set', mode: 'all',
        children: [
          { type: 'contains', value: 'hello' },
          { type: 'contains', value: 'world' },
        ],
      },
      expected: true,
    },
    {
      name: "'all' mode fails when any child fails",
      output: 'hello world',
      assertion: {
        type: 'assert-set', mode: 'all',
        children: [
          { type: 'contains', value: 'hello' },
          { type: 'contains', value: 'absent' },
        ],
      },
      expected: false,
    },
    {
      name: "'any' mode passes when at least one child passes",
      output: 'hello',
      assertion: {
        type: 'assert-set', mode: 'any',
        children: [
          { type: 'contains', value: 'foo' },
          { type: 'contains', value: 'hello' },
          { type: 'contains', value: 'bar' },
        ],
      },
      expected: true,
    },
    {
      name: "'any' mode fails when no child passes",
      output: 'hello',
      assertion: {
        type: 'assert-set', mode: 'any',
        children: [
          { type: 'contains', value: 'foo' },
          { type: 'contains', value: 'bar' },
        ],
      },
      expected: false,
    },
    {
      name: 'child not: true inside assert-set is honored',
      output: 'hello',
      assertion: {
        type: 'assert-set', mode: 'all',
        children: [
          { type: 'contains', value: 'hello' },
          { type: 'contains', value: 'forbidden', not: true },
        ],
      },
      expected: true,
    },
    {
      name: 'top-level not: true on assert-set inverts the whole set',
      output: 'hello',
      assertion: {
        type: 'assert-set', mode: 'all', not: true,
        children: [
          { type: 'contains', value: 'hello' },
          { type: 'contains', value: 'absent' },
        ],
      },
      expected: true,
    },
    {
      name: 'nested assert-set works',
      output: 'the quick brown fox',
      assertion: {
        type: 'assert-set', mode: 'all',
        children: [
          { type: 'contains', value: 'fox' },
          {
            type: 'assert-set', mode: 'any',
            children: [
              { type: 'contains', value: 'quick' },
              { type: 'contains', value: 'lazy' },
            ],
          },
        ],
      },
      expected: true,
    },
  ];

  it.each(cases)('$name', ({ output, assertion, expected }) => {
    const r = runAssertions(output, [assertion]);
    assert.equal(r.details[0].passed, expected);
  });

  it('rejects an empty children array as invalid configuration', () => {
    assert.throws(
      () => runAssertions('x', [{
        type: 'assert-set',
        mode: 'all',
        children: [],
      }]),
      /assert-set.*requires non-empty.*children/,
    );
  });
});

describe('rougeN', () => {
  const cases = [
    { name: 'identical strings', actual: rougeN('hello world', 'hello world', 1), expected: 1 },
    { name: 'one-token swap', actual: rougeN('cat sat on the mat', 'cat sat on a mat', 1), expected: 0.8 },
    { name: 'no overlap', actual: rougeN('xyz qwe', 'abc def', 1), expected: 0 },
    { name: 'clipped repeated candidate n-grams', actual: rougeN('cat cat cat cat cat', 'the cat the cat', 1), expected: 0.5 },
    { name: 'Chinese single-character tokenization', actual: rougeN('你好世界', '你好朋友', 1), expected: 0.5 },
    { name: 'reference fewer tokens than n', actual: rougeN('a b c', 'a', 2), expected: 0 },
  ];

  it.each(cases)('$name', ({ actual, expected }) => {
    assert.ok(Math.abs(actual - expected) < 0.001, `expected ${expected}, got ${actual}`);
  });

  it('rouge-2 is lower than rouge-1 for one-token substitutions', () => {
    const r1 = rougeN('the quick brown fox', 'the quick red fox', 1);
    const r2 = rougeN('the quick brown fox', 'the quick red fox', 2);
    assert.ok(r2 < r1, `rouge-2 (${r2}) should be < rouge-1 (${r1})`);
  });
});

describe('levenshtein', () => {
  const cases = [
    { name: 'identical strings', a: 'hello', b: 'hello', expected: 0 },
    { name: 'left side empty', a: '', b: 'abc', expected: 3 },
    { name: 'right side empty', a: 'abc', b: '', expected: 3 },
    { name: 'classic kitten to sitting', a: 'kitten', b: 'sitting', expected: 3 },
    { name: 'single-char swap', a: 'cat', b: 'bat', expected: 1 },
    { name: 'Chinese deletion', a: '你好世界', b: '你好世', expected: 1 },
    { name: 'Chinese replacement', a: '你好', b: '世界', expected: 2 },
  ];

  it.each(cases)('$name', ({ a, b, expected }) => {
    assert.equal(levenshtein(a, b), expected);
  });
});

describe('bleu', () => {
  it('covers BLEU scoring boundaries', () => {
    const s = 'the quick brown fox jumps over the lazy dog';
    assert.ok(bleu(s, s) > 0.99);

    assert.equal(bleu('xyz qwe rtt mno', 'abc def ghi jkl'), 0);

    const score = bleu('cat sat', 'cat sat');
    assert.equal(score, 0, `BLEU-4 should be 0 for 2-token text, got ${score}`);

    const long = 'one two three four five six seven eight nine ten';
    const short = 'one two three four five six seven eight';
    const sShort = bleu(short, long, 2);
    const sLong = bleu(long, long, 2);
    assert.ok(sShort < sLong, `bp should pull short candidate's score below the full match`);
  });
});

describe('assertion integration', () => {
  const cases: Array<{ name: string; output: string; assertion: Assertion; expected: boolean }> = [
    {
      name: 'rouge_n_min passes when score meets threshold',
      output: 'cat sat on the mat',
      assertion: { type: 'rouge_n_min', reference: 'cat sat on a mat', n: 1, threshold: 0.7 },
      expected: true,
    },
    {
      name: 'rouge_n_min fails when below threshold',
      output: 'cat sat on the mat',
      assertion: { type: 'rouge_n_min', reference: 'a different sentence', n: 1, threshold: 0.5 },
      expected: false,
    },
    {
      name: 'levenshtein_max passes within tolerance',
      output: 'kitten',
      assertion: { type: 'levenshtein_max', reference: 'sitting', value: 5 },
      expected: true,
    },
    {
      name: 'levenshtein_max fails over tolerance',
      output: 'kitten',
      assertion: { type: 'levenshtein_max', reference: 'sitting', value: 2 },
      expected: false,
    },
    {
      name: 'bleu_min works in assertion form',
      output: 'the quick brown fox jumps over the lazy dog',
      assertion: { type: 'bleu_min', reference: 'the quick brown fox jumps over the lazy dog', threshold: 0.9 },
      expected: true,
    },
  ];

  it.each(cases)('$name', ({ output, assertion, expected }) => {
    const r = runAssertions(output, [assertion]);
    assert.equal(r.details[0].passed, expected);
  });
});
