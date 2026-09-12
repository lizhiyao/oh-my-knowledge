import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it } from 'vitest';
import { SignalSection } from '../../../src/studio/web/components/inbox/signals';
import { SkillBoard } from '../../../src/studio/web/components/inbox/skill-board';
import { baseItem } from '../../observability/inbox/_helpers';

const ATTACKS = [
  `';<script>alert(1)</script><img src=x onerror=alert(2)>"`,
  `constructor<svg onload=alert(3)>`,
  `__proto__" onmouseover="alert(4)`,
];

/**
 * 观测收件箱 React 版的转义安全（#839 收口，替代 inbox-event-safety.test.ts）。
 * HTML 版靠 e()/jsString 手工转义字符串拼接；React 版由 JSX 文本节点默认转义，
 * 这里锁定攻击载荷不会以可执行结构进入渲染输出。
 */
describe('inbox react rendering keeps event data as data', () => {
  it.each(ATTACKS)('escapes attack payloads in signal rows: %s', (attack) => {
    const item = baseItem({ skillName: attack, evidence: { query: attack, path: attack } });
    const html = renderToString(createElement(SignalSection, { items: [item], lang: 'zh' }));
    assert.ok(!html.includes('<script>alert(1)</script>'), 'script tag must not survive');
    assert.ok(!html.includes('<img src=x onerror'), 'img onerror must not survive');
    assert.ok(!html.includes('<svg onload'), 'svg onload must not survive');
    assert.ok(!html.includes('onmouseover="alert'), 'handler attribute must not survive');
  });

  it.each(ATTACKS)('escapes attack payloads in the skill board: %s', (attack) => {
    const item = baseItem({ skillName: attack, occurrences: 2 });
    const html = renderToString(createElement(SkillBoard, {
      model: {
        allItems: [item],
        skillInvocationCounts: {},
        skillSessionCounts: {},
        skillInvocationLastSeen: {},
        skillToolCallCounts: {},
      },
      lang: 'zh',
    }));
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(!html.includes('<img src=x onerror'));
    assert.ok(!html.includes('<svg onload'));
  });
});
