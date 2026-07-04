import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { shellQuoteArg } from '../../src/shared/shell-quote.js';

describe('shellQuoteArg', () => {
  it('keeps simple path-like arguments readable', () => {
    assert.equal(shellQuoteArg('/tmp/omk-observe-inbox'), '/tmp/omk-observe-inbox');
  });

  it('single-quotes arguments with spaces or apostrophes', () => {
    assert.equal(shellQuoteArg("/tmp/omk inbox/user's trace"), "'/tmp/omk inbox/user'\\''s trace'");
  });
});
