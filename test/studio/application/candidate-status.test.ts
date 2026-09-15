/**
 * 候选知识有两个维度：用户做过的维护决定，与知识层恒为 `pending` 的领域复核。
 *
 * 标签只命名前者。措辞一旦把「已保留」写成复核通过，用户就会把愿意维护读成内容已证实，
 * 所以口径在 application 层锁；页面渲染出什么由 test/studio/web/knowledge-candidate-decision.test.tsx 负责。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
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
