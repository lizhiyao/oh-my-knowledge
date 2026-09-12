import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  INDICATOR_KEYS,
  indicatorHelp,
  indicatorLabel,
} from '../../../src/observability/inbox/metric-semantics.js';

describe('metric semantics (host-independent)', () => {
  it('covers every indicator key in both languages', () => {
    assert.equal(INDICATOR_KEYS.length, 33);
    for (const key of INDICATOR_KEYS) {
      assert.ok(indicatorLabel(key, 'zh').length > 0, `zh label for ${key}`);
      assert.ok(indicatorLabel(key, 'en').length > 0, `en label for ${key}`);
      assert.ok(indicatorHelp(key, 'zh').length > 0, `zh help for ${key}`);
      assert.ok(indicatorHelp(key, 'en').length > 0, `en help for ${key}`);
    }
  });

  it('keeps zh labels byte-identical to the legacy HTML dictionary', () => {
    assert.equal(indicatorLabel('userCorrection', 'zh'), '用户纠正');
    assert.equal(indicatorLabel('toolCall', 'zh'), '工具调用');
    assert.equal(indicatorLabel('llmSkillTypeWorkflowOwner', 'zh'), '流程负责型（能力定位）');
    assert.equal(indicatorLabel('bashProbe', 'zh'), 'Bash 试探');
  });

  it('keeps zh help text byte-identical to the legacy HTML dictionary', () => {
    assert.equal(
      indicatorHelp('bash', 'zh'),
      '统计该 skill 运行期间调用 Bash 工具的次数。',
    );
    assert.equal(
      indicatorHelp('hedging', 'zh'),
      '统计回答或过程发现里的“不确定 / 可能 / 需要确认”等低置信文本信号。',
    );
    assert.equal(
      indicatorHelp('toolFailure', 'zh'),
      '统计该 skill 运行片段里失败的工具执行结果，例如 tool_result 标记 is_error=true。注意：工具执行失败不等于整个 skill 调用失败。',
    );
  });
});
