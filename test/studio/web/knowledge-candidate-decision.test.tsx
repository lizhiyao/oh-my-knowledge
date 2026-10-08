/**
 * 候选详情头与列表行读到的决定文案：用户做过什么决定、理由是否回显、复核维度有没有被冒充。
 *
 * 措辞口径由 test/studio/application/candidate-status.test.ts 锁；这里只断言页面真正渲染出的文字。
 */
import { candidateMatches, CandidateDecisionHeader, CandidatePaneSwitch, CandidateRowStatus } from '../../../src/studio/web/components/knowledge/candidates.js';
import { CandidateDecisionActions, CandidateReviewProgress, CandidateReviewSummary } from '../../../src/studio/web/components/knowledge/candidate-review.js';
import type { KnowledgeReviewBatch, KnowledgeCandidateDetail } from '../../../src/studio/view-models/knowledge/knowledge-candidates.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, replace() {}, refresh() {} }) }));

const retained: NonNullable<KnowledgeCandidateDetail['maintenance']> = {
  revisionId: 'revision-1', choice: 'retain', reason: '值得复用', at: '2026-09-14T00:01:00Z',
  actor: { actorKind: 'human', actorId: 'lizhiyao' },
};
const header = (maintenance: KnowledgeCandidateDetail['maintenance'] = null, lang: 'zh' | 'en' = 'zh') =>
  renderToStaticMarkup(createElement(CandidateDecisionHeader, { title: '评测门禁口径', maintenance, lang }));
const row = (choice: 'retain' | 'discard' | null, lang: 'zh' | 'en' = 'zh') =>
  renderToStaticMarkup(createElement(CandidateRowStatus, { choice, lang }));

describe('candidate decision display', () => {
  it('finds retained or undecided knowledge by title without treating a decision as verification', () => {
    const row = { title: 'Taro 判断更正', choice: 'retain' as const };
    expect(candidateMatches(row, 'retain', ' taro ')).toBe(true);
    expect(candidateMatches(row, 'pending', '')).toBe(false);
    expect(candidateMatches({ ...row, choice: null }, 'pending', '判断')).toBe(true);
    expect(candidateMatches(row, 'all', '其他')).toBe(false);
  });

  it('summarizes this batch with truthful next actions, its source and selected folder', () => {
    const batch: KnowledgeReviewBatch = { runId: 'one', rows: [], total: 3, retained: 1, discarded: 2, pending: 0, missing: 0, complete: true };
    for (const lang of ['zh', 'en'] as const) {
      const html = renderToStaticMarkup(createElement(CandidateReviewSummary, { batch, lang, workspace: '/isolated', originHref: '/observe/source?workspace=%2Fisolated', busy: false, onRevisit() {}, onLibrary() {} }));
      expect(html).toContain(lang === 'zh' ? '已保留 1 条，已舍弃 2 条。' : '1 retained, 2 discarded.');
      expect(html).toContain(lang === 'zh' ? '人工整理' : 'manually update');
      expect(html).toContain(lang === 'zh' ? '受控评测' : 'controlled comparison');
      expect(html).toContain('href="/knowledge?workspace=%2Fisolated"');
      expect(html).toContain('href="/measure?workspace=%2Fisolated"');
      expect(html).toContain('href="/observe/source?workspace=%2Fisolated"');
    }
    const discarded = renderToStaticMarkup(createElement(CandidateReviewSummary, { batch: { ...batch, retained: 0, discarded: 3 }, lang: 'zh', workspace: '/isolated', busy: false, onRevisit() {}, onLibrary() {} }));
    expect(discarded).toContain('历史修订均已保存');
    expect(discarded).not.toContain('查看评测记录');
  });
  it('reports unavailable candidates without counting them as handled', () => {
    const html = renderToStaticMarkup(createElement(CandidateReviewProgress, { batch: { runId: 'one', rows: [], total: 3, retained: 1, discarded: 0, pending: 1, missing: 1, complete: false }, lang: 'zh', busy: true, previous: true, onPrevious() {}, onLibrary() {} }));
    expect(html).toContain('已处理 1／3 条');
    expect(html).toContain('1 条无法读取');
    expect(html).toContain('回看上一条');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
  it('requires an editable reason and another explicit decision; reload blocks repeated writes', () => {
    const render = (reason: string, needsRefresh = false) => renderToStaticMarkup(createElement(CandidateDecisionActions, { lang: 'zh', reason, needsRefresh, busy: false, onReason() {}, onEdit() {}, onDecision() {} }));
    expect(render('')).toContain('快捷理由（选择后仍需确认决定）');
    expect(render(' ').match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(render('自己的理由')).toContain('value="自己的理由"');
    expect(render('自己的理由')).not.toMatch(/<button[^>]*disabled=""/);
    expect(render('已保存理由', true).match(/<button[^>]*disabled=""/g)).toHaveLength(3);
  });
  it('identifies the selected review view and the panel each switch controls in both languages', () => {
    for (const lang of ['zh', 'en'] as const) {
      for (const pane of ['candidate', 'evidence'] as const) {
        const html = renderToStaticMarkup(createElement(CandidatePaneSwitch, { lang, pane, onChange() {} }));
        expect(html).toContain(lang === 'zh' ? '候选内容' : 'Candidate content');
        expect(html).toContain(lang === 'zh' ? '原始依据' : 'Source evidence');
        expect(html).toMatch(new RegExp(`aria-pressed="true" aria-controls="candidate-${pane === 'candidate' ? 'content' : 'evidence'}"`));
      }
    }
  });
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
