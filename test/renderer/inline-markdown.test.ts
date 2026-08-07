import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { inlineMarkdownText, renderSafeInlineMarkdown } from '../../src/renderer/inline-markdown.js';

describe('safe inline Markdown renderer', () => {
  it('renders supported inline semantics and can suppress nested links', () => {
    const source = '[OMK](https://example.com/omk) 使用 **证据** 和 `trace`';

    assert.equal(
      renderSafeInlineMarkdown(source),
      '<a class="inline-markdown-link" href="https://example.com/omk" target="_blank" rel="noreferrer noopener">OMK</a> 使用 <strong>证据</strong> 和 <code>trace</code>',
    );
    assert.equal(
      renderSafeInlineMarkdown(source, { links: 'text' }),
      'OMK 使用 <strong>证据</strong> 和 <code>trace</code>',
    );
    assert.equal(inlineMarkdownText(source), 'OMK 使用 证据 和 trace');
  });

  it('escapes HTML and refuses unsafe link protocols', () => {
    const source = '[危险链接](javascript:alert(1)) <img src=x onerror=alert(1)>';
    const rendered = renderSafeInlineMarkdown(source);

    assert.ok(!rendered.includes('<a'));
    assert.ok(!rendered.includes('<img'));
    assert.ok(rendered.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });

  it('truncates visible text without exposing partial Markdown markers', () => {
    assert.equal(
      renderSafeInlineMarkdown('**Tracing unexpected process respawn** and more', { maxLength: 34 }),
      '<strong>Tracing unexpected process respaw</strong>…',
    );
  });
});
