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
import { bodyWrite, bodyActor } from '../../knowledge/body-fixtures.js';
import { FileKnowledgeStore } from '../../../src/knowledge/adapters/knowledge-store.js';
import { knowledgeBodyDigest } from '../../../src/knowledge/adapters/body-digest.js';
import { FileSourceStore } from '../../../src/knowledge/adapters/source-store';
import { sourceSnapshotProjection } from '../../../src/knowledge/sources';
import { fileSourceFixture } from './source-fixture';
it('reads exact persisted knowledge, context and source classification in both entries without claiming verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-reader-'));
  try {
    const app = createLocalKnowledgeApplication(root);
    const source = new FileSourceStore(join(root, 'sources'), root).capture(sourceSnapshotProjection(fileSourceFixture({ snapshotId: '00000000-0000-4000-8000-000000000003', sourceVersion: `sha256:${'a'.repeat(64)}` }, 'Alpha 使用 Beta'))).snapshot;
    const command = bodyWrite();
    command.knowledgeId = command.revision.knowledgeId = '00000000-0000-4000-8000-000000000050';
    command.revision.revisionId = '00000000-0000-4000-8000-000000000051';
    command.revision.title = '<script>Source claim</script>';
    command.revision.content.segments[0].text = "报告者称 Alpha 使用 Beta；未记录版本。未来适用范围尚未验证，当前 master 未发布。配置值为布尔值 false，不能解释成字符串 'false'。";
    command.revision.content.segments[0].evidence = [{ source: { snapshotId: source.snapshotId, sourceVersion: source.sourceVersion }, basis: 'source_assertion',
      selection: { evidenceRef: source.excerpts[0].evidenceRef, start: 0, end: 13, quote: 'Alpha 使用 Beta' } }];
    command.revision.bodyDigest = knowledgeBodyDigest(command.revision);
    new FileKnowledgeStore(join(root, 'items'), 'local', root).write(command, bodyActor);
    const id = command.knowledgeId;
    app.deleteSource({ snapshotId: source.snapshotId, sourceVersion: source.sourceVersion });
    const detail = await executeKnowledgeCandidateAction({ workspace: root, operation: 'show', id }) as KnowledgeCandidateDetail;
    for (const lang of ['zh', 'en'] as const) {
      const html = renderToStaticMarkup(createElement(KnowledgeReader, { detail, lang, onRevision() {}, onRetry() {} }));
      expect(html).toContain('&lt;script&gt;Source claim&lt;/script&gt;'); expect(html).not.toContain('<script>');
      expect(html).toContain(lang === 'zh' ? '来源不可用' : 'Source unavailable');
      expect(html).toContain(lang === 'zh' ? '不等于内容已得到证实' : 'not verifying its truth');
      expect(html).toContain('未记录版本'); expect(html).toContain('未来适用范围尚未验证');
      expect(html).toContain(lang === 'zh' ? '修订历史' : 'Revision history');
      expect(html).toContain('当前 master 未发布'); expect(html).toContain('配置值为布尔值 false');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('renders carrier Markdown as reading content while retaining safe code, references and original semantics', () => {
  const html = renderToStaticMarkup(createElement(CarrierDocument, { lang: 'zh', content: '---\nname: hidden-metadata\n---\n# 实际正文\n\n<script>unsafe</script>\n\n[unsafe](javascript:alert)\n\n![remote](https://example.test/image.png)\n\n[local](references/evidence.md)\n\n```js\nconst enabled = false;\n```' }));
  expect(html).toContain('实际正文'); expect(html).not.toContain('hidden-metadata'); expect(html).not.toContain('<script>');
  expect(html).not.toContain('href="javascript:'); expect(html).not.toContain('<img'); expect(html).toContain('href="https://example.test/image.png"');
  expect(html).toContain('references/evidence.md'); expect(html).toContain('const enabled = false;');
});

it.each(['project_file', 'git_blob'] as const)('renders %s coordinates, material and exact quotation without inventing conversation or execution provenance', sourceKind => {
  const snapshot = fileSourceFixture({ snapshotId: '00000000-0000-4000-8000-000000000003', sourceVersion: `sha256:${'a'.repeat(64)}` }, '😀 Alpha\r\nAlpha <script>source</script>',
    { sourceKind, relativePath: 'docs/Alpha.md', materialType: sourceKind === 'git_blob' ? 'implementation' : 'design' });
  const source = { snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion }, excerpt = snapshot.excerpts[0], start = excerpt.text.lastIndexOf('Alpha');
  const revision = { ...bodyWrite().revision, content: { segments: [{ segmentId: 's1', text: '材料中关于 Alpha 的有条件说法，未证明当前实现。', evidence: [{ source,
    selection: { evidenceRef: excerpt.evidenceRef, start, end: start + 5, quote: 'Alpha' }, basis: 'source_assertion' as const }] }] } };
  const detail: KnowledgeCandidateDetail = { revision, history: { storeKind: 'knowledge-item-history', schemaVersion: 3, namespace: 'fixture', knowledgeId: revision.knowledgeId,
    generation: 1, writeHeadRevisionId: revision.revisionId, revisions: [revision], maintenance: [], receipts: [] }, maintenance: null, reviewStatus: 'pending', tagging: { generation: 0, tags: [] },
    derivedCatalogs: [], derivedAssociations: { status: 'absent', reviewStatus: 'pending', bodyRef: { knowledgeId: revision.knowledgeId, revisionId: revision.revisionId, bodyDigest: revision.bodyDigest }, generation: 0, headRevisionId: null },
    sources: [{ status: 'available', snapshot }] };
  const html = renderToStaticMarkup(createElement(KnowledgeReader, { detail, lang: 'zh', selection: { tab: 'evidence', segmentId: 's1' }, onRevision() {}, onRetry() {} }));
  expect(html).toContain('docs/Alpha.md'); expect(html).toContain('project-alpha'); expect(html).toContain('第 3–4 行'); expect(html).toContain('UTF-8 字节 [17,');
  expect(html).toContain('😀 Alpha\r\n<mark data-focused="true">Alpha</mark>'); expect(html).toContain('&lt;script&gt;source&lt;/script&gt;'); expect(html).not.toContain('<script>source');
  expect(html).toContain('不证明当前实现或真实执行。'); expect(html).not.toContain('来源记录'); expect(html).not.toContain('/observe/conversations/');
  expect(html).toContain(sourceKind === 'git_blob' ? '实现材料' : '设计材料');
  if (snapshot.sourceKind === 'git_blob') {
    const identity = html.indexOf('精确来源身份与材料归因');
    expect(html.slice(0, identity)).not.toContain(snapshot.identity.commitOid); expect(html.slice(identity)).toContain(snapshot.identity.commitOid);
    expect(html.slice(identity)).toContain(snapshot.identity.blobOid);
  }
});
