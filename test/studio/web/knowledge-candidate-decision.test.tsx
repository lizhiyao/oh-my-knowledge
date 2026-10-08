/**
 * 候选详情头与列表行读到的决定文案：用户做过什么决定、理由是否回显、复核维度有没有被冒充。
 *
 * 措辞口径由 test/studio/application/candidate-status.test.ts 锁；这里只断言页面真正渲染出的文字。
 */
import { candidateMatches, nextPendingCandidateId, CandidateDecisionHeader, CandidateNextStep, CandidatePaneSwitch, CandidateRowStatus } from '../../../src/studio/web/components/knowledge/candidates.js';
import type { KnowledgeCandidateDetail } from '../../../src/studio/view-models/knowledge/knowledge-candidates.js';
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
  it('continues through every undecided item in list order, skips decided items and wraps without reopening the current item', () => {
    const rows = [{ knowledgeId: 'retained', choice: 'retain' as const }, ...['first', 'second', 'third'].map(knowledgeId => ({ knowledgeId, choice: null }))];
    expect(nextPendingCandidateId(rows, 'retained')).toBe('first');
    expect(nextPendingCandidateId(rows, 'first')).toBe('second');
    expect(nextPendingCandidateId(rows, 'second')).toBe('third');
    expect(nextPendingCandidateId(rows, 'third')).toBe('first');
    expect(nextPendingCandidateId(rows, 'missing')).toBe('first');
    expect(nextPendingCandidateId([{ knowledgeId: 'only', choice: null }], 'only')).toBeUndefined();
  });

  it('finds retained or undecided knowledge by title without treating a decision as verification', () => {
    const row = { title: 'Taro 判断更正', choice: 'retain' as const };
    expect(candidateMatches(row, 'retain', ' taro ')).toBe(true);
    expect(candidateMatches(row, 'pending', '')).toBe(false);
    expect(candidateMatches({ ...row, choice: null }, 'pending', '判断')).toBe(true);
    expect(candidateMatches(row, 'all', '其他')).toBe(false);
  });

  it('explains how to reopen and use retained content, with truthful browse actions and the selected folder', () => {
    for (const lang of ['zh', 'en'] as const) {
      const html = renderToStaticMarkup(createElement(CandidateNextStep, { lang, choice: 'retain', workspace: '/isolated', pending: true, onNext() {} }));
      expect(html).toContain(lang === 'zh' ? '人工整理' : 'manually update');
      expect(html).toContain(lang === 'zh' ? '受控评测' : 'controlled comparison');
      expect(html).toContain('href="/knowledge?workspace=%2Fisolated"');
      expect(html).toContain('href="/measure?workspace=%2Fisolated"');
      expect(html).toContain(lang === 'zh' ? '核对下一条待处理知识' : 'Review the next undecided item');
    }
    const discarded = renderToStaticMarkup(createElement(CandidateNextStep, { lang: 'zh', choice: 'discard', workspace: '/isolated', pending: false, onNext() {} }));
    expect(discarded).toContain('历史仍可回看');
    expect(discarded).not.toContain('查看评测记录');
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
