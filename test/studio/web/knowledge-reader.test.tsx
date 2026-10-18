import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { createLocalKnowledgeApplication } from '../../../src/knowledge/application/local.js';
import { executeKnowledgeCandidateAction } from '../../../src/studio/application/knowledge/knowledge-candidates.js';
import type { KnowledgeCandidateDetail } from '../../../src/studio/view-models/knowledge/knowledge-candidates.js';
import { KnowledgeReader } from '../../../src/studio/web/components/knowledge/reader.js';
import { CarrierDocument } from '../../../src/studio/web/components/knowledge/carrier-document.js';
import { modelWindow } from '../../knowledge/fixtures.js';
it('reads exact persisted knowledge, context and source classification in both entries without claiming verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-reader-'));
  try {
    const app = createLocalKnowledgeApplication(root);
    const source = app.capture({ path: join(root, 'fixture.jsonl'), records: [{ recordIndex: 1, raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }) }] });
    const run = await app.generate(source.snapshotId, { executor: 'recorded-fixture', model: 'no-model-call', generate: async (_system, input) => {
      const packet = modelWindow(); packet.proposals[0].draft.title = '<script>Source claim</script>';
      return { output: JSON.stringify(packet).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 0 };
    } });
    const id = run.committed[0].knowledgeId;
    app.deleteSource(source.snapshotId);
    const detail = await executeKnowledgeCandidateAction({ workspace: root, operation: 'show', id }) as KnowledgeCandidateDetail;
    for (const lang of ['zh', 'en'] as const) {
      const html = renderToStaticMarkup(createElement(KnowledgeReader, { detail, lang, onRevision() {}, onRetry() {} }));
      expect(html).toContain('&lt;script&gt;Source claim&lt;/script&gt;'); expect(html).not.toContain('<script>');
      expect(html).toContain(lang === 'zh' ? '来源不可用' : 'Source unavailable');
      expect(html).toContain(lang === 'zh' ? '不等于内容已得到证实' : 'not verifying its truth');
      expect(html).toContain('未记录版本'); expect(html).toContain('未来适用范围尚未验证');
      expect(html).toContain(lang === 'zh' ? '修订历史' : 'Revision history');
      expect(html).toContain(lang === 'zh' ? '推断' : 'Inference');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('renders carrier Markdown as reading content while retaining safe code, references and original semantics', () => {
  const html = renderToStaticMarkup(createElement(CarrierDocument, { lang: 'zh', content: '---\nname: hidden-metadata\n---\n# 实际正文\n\n<script>unsafe</script>\n\n[unsafe](javascript:alert)\n\n![remote](https://example.test/image.png)\n\n[local](references/evidence.md)\n\n```js\nconst enabled = false;\n```' }));
  expect(html).toContain('实际正文'); expect(html).not.toContain('hidden-metadata'); expect(html).not.toContain('<script>');
  expect(html).not.toContain('href="javascript:'); expect(html).not.toContain('<img'); expect(html).toContain('href="https://example.test/image.png"');
  expect(html).toContain('references/evidence.md'); expect(html).toContain('const enabled = false;');
});
