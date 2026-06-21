/**
 * 别项目「索引卡片」(resultsStripped)进 studio 详情时的渲染口径守卫。
 * 卡片 results 被剥掉 → passCount/failCount 留 0,但 totalSamples / compositeScore / verdict 真实。
 * 渲染端不能让 failCount===0 误判绿带「所有用例通过」、也不能显「0% 通过」—— 与同屏综合分自相矛盾。
 * 改成:eval section 用占位「明细在源项目」替代通过率,色带按 compositeScore 定(非按 pass/fail)。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { renderSkillDetail } from '../../src/renderer/skill-detail-renderer.js';
import type { SkillIndexEntry } from '../../src/types/skill-index.js';

function cardShellEntry(): SkillIndexEntry {
  return {
    skillName: 'cross-project-skill',
    doctor: null,
    eval: {
      reportId: 'x-20260614T141600-ab12',
      timestamp: '2026-06-14T14:16:00Z',
      variantName: 'x',
      verdictLevel: 'PROGRESS',
      verdictHeadline: '处理更稳',
      compositeScore: 4.3, // 可信:来自 summary
      passCount: 0, // 卡片剥空,占位
      failCount: 0,
      tripwireCount: 0,
      totalSamples: 3, // 来自 summary.totalSamples
      resultsStripped: true,
    },
    observe: null,
    doctorHistory: [],
    evalHistory: [],
    observeHistory: [],
    band: 'green',
  } as unknown as SkillIndexEntry;
}

describe('索引卡片 eval section 渲染口径', () => {
  it('不显「0% 通过」、不显「所有用例通过」,改显「明细在源项目」占位', () => {
    const html = renderSkillDetail(cardShellEntry(), null, 'zh');
    assert.doesNotMatch(html, /0% 通过/, 'pass/fail 剥空时不得显 0% 通过');
    assert.doesNotMatch(html, /所有用例通过/, 'failCount===0 不得误判全通过');
    assert.match(html, /明细在源项目|逐样本明细需在源项目查看/, '给出明细需回源项目的占位');
  });

  it('totalSamples 真实显示(不退化成 0 用例)', () => {
    const html = renderSkillDetail(cardShellEntry(), null, 'zh');
    assert.match(html, /3 用例/, 'totalSamples 用 summary 真实样本数');
  });
});
