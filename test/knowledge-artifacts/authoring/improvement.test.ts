import { describe, expect, it } from 'vitest';
import { buildImprovementPrompt, computeEditDelta } from '../../../src/knowledge-artifacts/authoring/improvement.js';

describe('authoring improvement helpers', () => {
  it('computes a deterministic line-level edit delta without treating reordering as a change', () => {
    expect(computeEditDelta('alpha\nbeta', 'beta\nalpha')).toEqual({
      ratio: 0,
      changedLines: 0,
      summary: '(无文本差异)',
    });
    expect(computeEditDelta('alpha\nbeta', 'alpha\ngamma')).toEqual({
      ratio: 1,
      changedLines: 2,
      summary: '+ gamma\n- beta',
    });
  });

  it('builds improvement context from Core weak-sample evidence and rejected edits', () => {
    const prompt = buildImprovementPrompt('原始 skill', 3.25, [{
      sample_id: 'sample-1',
      compositeScore: 2.5,
      llmReason: '缺少边界说明',
      failedAssertions: ['必须拒绝危险操作'],
      dimensions: { safety: 2, clarity: 3 },
    }], ['不要只增加冗长示例']);

    expect(prompt).toContain('当前 Skill（平均分：3.25/5.0）');
    expect(prompt).toContain('### sample-1（2.5/5.0）');
    expect(prompt).toContain('评委反馈：缺少边界说明');
    expect(prompt).toContain('失败断言：必须拒绝危险操作');
    expect(prompt).toContain('不要只增加冗长示例');
  });
});
