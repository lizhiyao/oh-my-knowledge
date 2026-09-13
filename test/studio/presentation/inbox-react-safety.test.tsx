import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, it } from 'vitest';
import { buildObservationInboxViewModel, type ObservationInboxViewModel } from '../../../src/observability/inbox/view-model.js';
import { SignalSection } from '../../../src/studio/web/components/inbox/signals';
import { SkillBoard } from '../../../src/studio/web/components/inbox/skill-board';
import { baseItem } from '../../observability/inbox/_helpers';

/**
 * 三类载荷：标签闭合、属性逃逸、原型链成员名。
 * 原型名是 HTML 版的显式用例（渲染与聚合把 skill 名当对象键），迁到 React 后仍要求它只是数据。
 */
const ATTACKS = [
  `';<script>alert(1)</script><img src=x onerror=alert(2)>"`,
  `constructor<svg onload=alert(3)>`,
  `__proto__" onmouseover="alert(4)`,
];

/** React 文本节点的转义结果，用于正向断言：值被整体丢弃同样算失败。 */
function reactText(payload: string): string {
  return payload
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

function assertInert(html: string, payload: string): void {
  for (const marker of ['<script>', '<img src=x', '<svg onload', 'onmouseover="alert']) {
    assert.ok(!html.includes(marker), `${marker} must not survive as markup`);
  }
  assert.ok(html.includes(reactText(payload)), 'payload must stay in the output as escaped text');
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 真实投影打底，只替换承载载荷的字段，避免手搓半个 view-model。 */
function viewModelWith(skillName: string): ObservationInboxViewModel {
  const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-react-safety-'));
  dirs.push(dir);
  return {
    ...buildObservationInboxViewModel(dir),
    allItems: [baseItem({ skillName })],
    items: [baseItem({ skillName })],
    skillInvocationCounts: Object.fromEntries([[skillName, 3]]),
  };
}

/**
 * 观测收件箱 React 版的转义安全（#839 收口，替代 inbox-event-safety.test.ts）。
 * HTML 版靠 e()/jsString 手工转义字符串拼接，并用 node:vm 证明注入串以数据实参到达；
 * React 版没有属性内联脚本这条路径，剩下的不变量是「轨迹派生文本只作为文本节点渲染」，
 * 由本文件锁定渲染结果、由 test/architecture/studio-react-raw-html.test.ts 锁定不得重新引入逃生口。
 */
describe('inbox react rendering keeps event data as data', () => {
  for (const attack of ATTACKS) {
    it(`escapes attack payloads in signal rows: ${attack}`, () => {
      const item = baseItem({ skillName: attack, evidence: { query: attack, path: attack } });
      assertInert(renderToString(createElement(SignalSection, { items: [item], lang: 'zh' })), attack);
    });

    it(`keeps an attack skill name as data in the skill board: ${attack}`, () => {
      assertInert(renderToString(createElement(SkillBoard, { model: viewModelWith(attack), lang: 'zh' })), attack);
    });
  }
});
