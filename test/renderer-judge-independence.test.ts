import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { renderAnalysis } from '../src/renderer/summary.js';
import type { Report } from '../src/types/index.js';

// 锁住评委独立性 insight 的渲染文案(localizedInsightMessage + localizedSuggestion 两个 case)。
// html-renderer 的静态快照 fixture 不含这两个 insight,故单独覆盖,避免文案静默漂走。
const reportWith = (type: string, severity: 'warning' | 'info' = 'warning'): Report => ({
  analysis: {
    insights: [{
      type,
      severity,
      details: { outputVendors: ['anthropic'], judgeVendors: ['anthropic', 'anthropic'], goldCalibrated: false },
    }],
  },
} as unknown as Report);

describe('renderAnalysis — 评委独立性 insight 文案', () => {
  it('judge_self_preference:中文消息 + 可执行建议(--judge-models / gold)', () => {
    const html = renderAnalysis(reportWith('judge_self_preference'), 'zh');
    assert.match(html, /自我偏好/);
    assert.match(html, /--judge-models/);
    assert.match(html, /gold/);
  });

  it('single_vendor_ensemble:英文消息 + 跨厂商建议', () => {
    const html = renderAnalysis(reportWith('single_vendor_ensemble'), 'en');
    assert.match(html, /shared bias|same-model/);
    assert.match(html, /--judge-models/);
  });
});
