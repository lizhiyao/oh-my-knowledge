import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { inlineMarkdownText } from '../../../src/studio/application/inline-markdown.js';

describe('inline Markdown visible text', () => {
  it('keeps the visible text of supported inline semantics', () => {
    assert.equal(
      inlineMarkdownText('[OMK](https://example.com/omk) 使用 **证据** 和 `trace`'),
      'OMK 使用 证据 和 trace',
    );
  });

  it('keeps unmatched markup literal instead of dropping characters', () => {
    assert.equal(
      inlineMarkdownText('未闭合的 `code 和 [链接 标签'),
      '未闭合的 `code 和 [链接 标签',
    );
  });

  it('honours backslash escapes so markers stay visible', () => {
    assert.equal(inlineMarkdownText('\\*不是强调\\*'), '*不是强调*');
  });
});
