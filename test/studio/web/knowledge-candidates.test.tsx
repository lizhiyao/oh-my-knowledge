import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KnowledgeCandidates } from '../../../src/studio/web/components/knowledge/candidates.js';

describe('candidate workspace entry', () => {
  it.each(['zh', 'en'] as const)('renders the shared workspace entry in %s', (lang) => {
    const html = renderToStaticMarkup(<KnowledgeCandidates lang={lang} initialWorkspace="/tmp/selected"/>);
    expect(html).toContain('/tmp/selected');
    expect(html).toContain(lang === 'zh' ? '默认在本地摘录规则条目，不调用模型' : 'extract labelled entries locally without a model');
    expect(html).toContain(lang === 'zh' ? '候选需要人工复核' : 'candidates require review');
  });
});
