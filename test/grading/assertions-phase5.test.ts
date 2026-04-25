import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { runAssertions, rougeN, levenshtein, bleu } from '../../src/grading/assertions.js';

describe('Phase 5a — universal `not: true` field', () => {
  it('not: true on contains inverts pass/fail', () => {
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
  });

  it('not: true on a regex assertion inverts', () => {
    const r = runAssertions('output 42', [
      { type: 'regex', pattern: '\\d+', not: true },
    ]);
    assert.equal(r.details[0].passed, false);
  });
});

describe('Phase 5a — assert-set combinator', () => {
  it("'all' mode requires every child to pass", () => {
    const r = runAssertions('hello world', [{
      type: 'assert-set', mode: 'all',
      children: [
        { type: 'contains', value: 'hello' },
        { type: 'contains', value: 'world' },
      ],
    }]);
    assert.equal(r.details[0].passed, true);
  });

  it("'all' mode fails when any child fails", () => {
    const r = runAssertions('hello world', [{
      type: 'assert-set', mode: 'all',
      children: [
        { type: 'contains', value: 'hello' },
        { type: 'contains', value: 'absent' },
      ],
    }]);
    assert.equal(r.details[0].passed, false);
  });

  it("'any' mode passes when at least one child passes", () => {
    const r = runAssertions('hello', [{
      type: 'assert-set', mode: 'any',
      children: [
        { type: 'contains', value: 'foo' },
        { type: 'contains', value: 'hello' },
        { type: 'contains', value: 'bar' },
      ],
    }]);
    assert.equal(r.details[0].passed, true);
  });

  it("'any' mode fails when no child passes", () => {
    const r = runAssertions('hello', [{
      type: 'assert-set', mode: 'any',
      children: [
        { type: 'contains', value: 'foo' },
        { type: 'contains', value: 'bar' },
      ],
    }]);
    assert.equal(r.details[0].passed, false);
  });

  it('child not: true inside assert-set is honored', () => {
    const r = runAssertions('hello', [{
      type: 'assert-set', mode: 'all',
      children: [
        { type: 'contains', value: 'hello' },
        { type: 'contains', value: 'forbidden', not: true },
      ],
    }]);
    assert.equal(r.details[0].passed, true);
  });

  it('top-level not: true on assert-set inverts the whole set', () => {
    const r = runAssertions('hello', [{
      type: 'assert-set', mode: 'all', not: true,
      children: [
        { type: 'contains', value: 'hello' },
        { type: 'contains', value: 'absent' },
      ],
    }]);
    // raw set returns false (one child fails); not: true → true.
    assert.equal(r.details[0].passed, true);
  });

  it('nested assert-set works', () => {
    const r = runAssertions('the quick brown fox', [{
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
    }]);
    assert.equal(r.details[0].passed, true);
  });

  it('empty children array fails', () => {
    const r = runAssertions('x', [{ type: 'assert-set', mode: 'all', children: [] }]);
    assert.equal(r.details[0].passed, false);
  });
});

describe('Phase 5b — rougeN', () => {
  it('returns 1.0 for identical strings', () => {
    assert.equal(rougeN('hello world', 'hello world', 1), 1);
  });

  it('returns ~0.8 for one-token swap on a 5-token reference', () => {
    // candidate: cat sat on the mat; reference: cat sat on a mat
    // Overlap: cat, sat, on, mat → 4 of 5 reference unigrams = 0.8
    const score = rougeN('cat sat on the mat', 'cat sat on a mat', 1);
    assert.ok(Math.abs(score - 0.8) < 0.001, `expected 0.8, got ${score}`);
  });

  it('returns 0 for no overlap', () => {
    assert.equal(rougeN('xyz qwe', 'abc def', 1), 0);
  });

  it('clips repeated candidate n-grams to reference count', () => {
    // Candidate spams "cat" but reference has it only twice.
    const score = rougeN('cat cat cat cat cat', 'the cat the cat', 1);
    // Reference unigrams: the, cat, the, cat → 4 tokens. Overlap clipped at min(cand=5, ref=2) = 2.
    // ROUGE-1 recall = 2 / 4 = 0.5
    assert.ok(Math.abs(score - 0.5) < 0.001, `expected 0.5, got ${score}`);
  });

  it('handles Chinese single-character tokenization', () => {
    // 你好世界 vs 你好朋友 — overlap on 你, 好 → 2 of 4 unigrams = 0.5
    const score = rougeN('你好世界', '你好朋友', 1);
    assert.ok(Math.abs(score - 0.5) < 0.001, `expected 0.5, got ${score}`);
  });

  it('returns 0 when reference has fewer tokens than n', () => {
    assert.equal(rougeN('a b c', 'a', 2), 0);
  });

  it('rouge-2 (bigram) is stricter than rouge-1', () => {
    const r1 = rougeN('the quick brown fox', 'the quick red fox', 1);
    const r2 = rougeN('the quick brown fox', 'the quick red fox', 2);
    assert.ok(r2 < r1, `rouge-2 (${r2}) should be < rouge-1 (${r1})`);
  });
});

describe('Phase 5b — levenshtein', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(levenshtein('hello', 'hello'), 0);
  });

  it('returns the length when one side is empty', () => {
    assert.equal(levenshtein('', 'abc'), 3);
    assert.equal(levenshtein('abc', ''), 3);
  });

  it('classic example: kitten → sitting is 3', () => {
    assert.equal(levenshtein('kitten', 'sitting'), 3);
  });

  it('single-char swap is 1', () => {
    assert.equal(levenshtein('cat', 'bat'), 1);
  });

  it('handles Chinese characters', () => {
    assert.equal(levenshtein('你好世界', '你好世'), 1);
    assert.equal(levenshtein('你好', '世界'), 2);
  });
});

describe('Phase 5b — bleu', () => {
  it('returns 1.0 for identical strings (long enough for 4-grams)', () => {
    const s = 'the quick brown fox jumps over the lazy dog';
    assert.ok(bleu(s, s) > 0.99);
  });

  it('returns 0 when no overlap', () => {
    assert.equal(bleu('xyz qwe rtt mno', 'abc def ghi jkl'), 0);
  });

  it('returns 0 when candidate too short for 4-grams (unsmoothed)', () => {
    // BLEU-4 unsmoothed degenerates on short text — documented behavior.
    const score = bleu('cat sat', 'cat sat');
    assert.equal(score, 0, `BLEU-4 should be 0 for 2-token text, got ${score}`);
  });

  it('brevity penalty is < 1 when candidate is shorter than reference', () => {
    const long = 'one two three four five six seven eight nine ten';
    const short = 'one two three four five six seven eight';
    // Both share many n-grams; BP makes short < 1 even with perfect precision.
    const sShort = bleu(short, long, 2);
    const sLong = bleu(long, long, 2);
    assert.ok(sShort < sLong, `bp should pull short candidate's score below the full match`);
  });
});

describe('Phase 5b — assertion integration', () => {
  it('rouge_n_min passes when score meets threshold', () => {
    const r = runAssertions('cat sat on the mat', [
      { type: 'rouge_n_min', reference: 'cat sat on a mat', n: 1, threshold: 0.7 },
    ]);
    assert.equal(r.details[0].passed, true);
  });

  it('rouge_n_min fails when below threshold', () => {
    const r = runAssertions('cat sat on the mat', [
      { type: 'rouge_n_min', reference: 'a different sentence', n: 1, threshold: 0.5 },
    ]);
    assert.equal(r.details[0].passed, false);
  });

  it('levenshtein_max passes within tolerance', () => {
    const r = runAssertions('kitten', [
      { type: 'levenshtein_max', reference: 'sitting', value: 5 },
    ]);
    assert.equal(r.details[0].passed, true);
  });

  it('levenshtein_max fails over tolerance', () => {
    const r = runAssertions('kitten', [
      { type: 'levenshtein_max', reference: 'sitting', value: 2 },
    ]);
    assert.equal(r.details[0].passed, false);
  });

  it('bleu_min works in assertion form', () => {
    const r = runAssertions('the quick brown fox jumps over the lazy dog', [
      { type: 'bleu_min', reference: 'the quick brown fox jumps over the lazy dog', threshold: 0.9 },
    ]);
    assert.equal(r.details[0].passed, true);
  });
});
