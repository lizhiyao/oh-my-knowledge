/**
 * 候选知识有两个维度：用户做过的维护决定，与知识层恒为 `pending` 的领域复核。
 *
 * 标签只命名前者。措辞一旦把「已保留」写成复核通过，用户就会把愿意维护读成内容已证实，
 * 所以口径在 application 层锁；页面渲染出什么由 test/studio/web/knowledge-candidate-decision.test.tsx 负责。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { candidateReviewRun, projectCandidateBatch } from '../../../src/studio/application/knowledge/candidate-review.js';
import type { KnowledgeCandidateRow, KnowledgeCandidateRun } from '../../../src/studio/view-models/knowledge/knowledge-candidates.js';
import { candidateDecisionLabel, extractionRunStatusLabel } from '../../../src/studio/application/knowledge/candidate-status.js';

describe('candidate status labels', () => {
  it('names the maintenance decision the user actually made', () => {
    assert.equal(candidateDecisionLabel('retain', 'zh'), '已保留');
    assert.equal(candidateDecisionLabel('discard', 'zh'), '已舍弃');
    assert.equal(candidateDecisionLabel(null, 'zh'), '待处理');
    assert.deepEqual((['retain', 'discard', null] as const).map((choice) => candidateDecisionLabel(choice, 'en')),
      ['Retained', 'Discarded', 'Undecided']);
  });

  it('never lets a decision label claim the review verdict knowledge keeps pending', () => {
    for (const lang of ['zh', 'en'] as const) {
      for (const choice of ['retain', 'discard', null] as const) {
        assert.doesNotMatch(candidateDecisionLabel(choice, lang), /证实|复核|verif|review/iu);
      }
    }
  });

  it('keeps one extraction run vocabulary and echoes an unknown status instead of guessing', () => {
    assert.equal(extractionRunStatusLabel('completed', 'zh'), '提炼完成');
    assert.equal(extractionRunStatusLabel('prepared', 'en'), 'Ready to save');
    assert.equal(extractionRunStatusLabel('queued', 'zh'), 'queued');
  });
});


describe('extraction review batch', () => {
  const run: KnowledgeCandidateRun = { runId: 'one', status: 'completed', committed: ['a', 'b', 'c'].map(knowledgeId => ({ knowledgeId, revisionId: 'original' })), rejections: [] };
  const row = (knowledgeId: string, choice: KnowledgeCandidateRow['choice']): KnowledgeCandidateRow => ({ knowledgeId, revisionId: 'latest', generation: 1, title: knowledgeId, reviewStatus: 'pending', choice });
  it('follows extraction order and wraps within that extraction, excluding unrelated candidates', () => {
    const rows = [row('unrelated', null), row('c', null), row('b', 'retain'), row('a', null)];
    assert.equal(candidateReviewRun([run], 'a'), run);
    assert.equal(candidateReviewRun([run], 'unrelated'), undefined);
    assert.deepEqual(projectCandidateBatch(run, rows, 'a')?.rows.map(item => item.knowledgeId), ['a', 'b', 'c']);
    assert.equal(projectCandidateBatch(run, rows, 'a')?.nextId, 'c');
    assert.equal(projectCandidateBatch(run, rows, 'c')?.nextId, 'a');
    assert.equal(projectCandidateBatch(run, rows, 'missing')?.nextId, 'a');
  });
  it('counts latest revision decisions and never carries a previous revision decision forward', () => {
    const rows = [row('a', 'retain'), row('b', 'discard'), row('c', 'retain')];
    const done = projectCandidateBatch(run, rows)!;
    assert.equal(done.complete, true); assert.equal(done.retained, 2); assert.equal(done.discarded, 1);
    const revised = projectCandidateBatch(run, [...rows.slice(0, 2), row('c', null)])!;
    assert.equal(revised.complete, false); assert.equal(revised.pending, 1); assert.equal(revised.retained, 1);
  });
  it('does not report completion for missing content, duplicates or an empty extraction', () => {
    const partial = projectCandidateBatch({ ...run, status: 'failed', committed: [...run.committed, run.committed[0]!] }, [row('a', 'retain'), row('b', 'discard')])!;
    assert.equal(partial.total, 3); assert.equal(partial.missing, 1); assert.equal(partial.complete, false);
    assert.equal(projectCandidateBatch(undefined, []), undefined);
    assert.equal(projectCandidateBatch({ ...run, committed: [] }, []), undefined);
    assert.equal(projectCandidateBatch({ ...run, committed: run.committed.slice(0, 1) }, [row('a', null)], 'a')?.nextId, undefined);
  });
});
