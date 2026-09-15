/**
 * 候选详情头与列表行读到的决定文案：用户做过什么决定、理由是否回显、复核维度有没有被冒充。
 *
 * 措辞口径由 test/studio/application/candidate-status.test.ts 锁；这里只断言页面真正渲染出的文字。
 */
import { CandidateDecisionHeader, CandidateRowStatus } from '../../../src/studio/web/components/knowledge/candidates.js';
import type { KnowledgeCandidateDetail } from '../../../src/studio/view-models/knowledge/knowledge-candidates.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, replace() {}, refresh() {} }) }));

const retained: NonNullable<KnowledgeCandidateDetail['maintenance']> = {
  revisionId: 'revision-1', choice: 'retain', reason: '值得复用', at: '2026-09-14T00:01:00Z',
  actor: { actorKind: 'human', actorId: 'lizhiyao' },
};
const header = (maintenance: KnowledgeCandidateDetail['maintenance'] = null, lang: 'zh' | 'en' = 'zh') =>
  renderToStaticMarkup(createElement(CandidateDecisionHeader, { title: '评测门禁口径', maintenance, lang }));
const row = (choice: 'retain' | 'discard' | null, lang: 'zh' | 'en' = 'zh') =>
  renderToStaticMarkup(createElement(CandidateRowStatus, { choice, lang }));

describe('candidate decision display', () => {
  it('reports the decision the user made instead of a constant pending review tag', () => {
    expect(header(retained)).toContain('已保留');
    expect(header(retained)).not.toContain('待复核');
    expect(header()).toContain('待处理');
    expect(header(null, 'en')).toContain('Undecided');
    expect(header({ ...retained, choice: 'discard' })).toContain('已舍弃');
  });

  it('shows the reason, actor, and time that a decision is required to leave behind', () => {
    expect(header(retained)).toContain('决定理由：「值得复用」');
    expect(header(retained)).toContain('决定人 lizhiyao');
    expect(header(retained)).toContain('2026-09-14 00:01:00 UTC');
    expect(header(retained, 'en')).toContain('Decision reason:');
    expect(header(retained, 'en')).toContain('by lizhiyao');
    expect(header()).not.toContain('决定理由');
  });

  it('keeps retaining distinct from verifying, with or without a decision', () => {
    expect(header(retained)).toContain('保留表示愿意维护，不等于内容已得到证实。');
    expect(header()).toContain('保留表示愿意维护，不等于内容已得到证实。');
    expect(header(retained, 'en')).toContain('not verifying its truth');
  });

  it('labels a list row with the decision only, in both languages', () => {
    expect(row('retain')).toContain('已保留');
    expect(row('discard')).toContain('已舍弃');
    expect(row(null)).toContain('待处理');
    expect(row(null)).not.toContain('待复核');
    expect(row('discard', 'en')).toContain('Discarded');
  });
});
