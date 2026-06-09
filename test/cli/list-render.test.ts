/**
 * `omk list` 表格渲染单测:锁住 dispWidth / truncate 的显示宽度语义、name 截断,以及**状态符组合不变量**
 * —— 不可达标「?」绝不冒充 stale,reachable 且漂移才 `stale ⚠️`。这层之前零覆盖,三元组一旦被改序就会
 * 误导用户对 drift 的判断却测不出来。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { renderTable, dispWidth, truncate } from '../../src/cli/commands/list.js';
import type { ManagedListRow } from '../../src/managed/index.js';

function row(over: Partial<ManagedListRow> = {}): ManagedListRow {
  return {
    id: 'id', name: 'review', kind: 'skill', sourceKind: 'file', sourceLabel: '/abs/review',
    state: 'installed', drifted: false, reachable: true,
    currentEvidenceCount: 0, totalEvidenceCount: 0, distributionCount: 1, ...over,
  };
}
// 单行表格的数据行(header 之后第一行)。
const dataLine = (r: ManagedListRow): string => renderTable([r], 'en').split('\n')[1];

describe('dispWidth', () => {
  it('CJK 全角按 2 列、ASCII 按 1 列', () => {
    assert.equal(dispWidth('名称'), 4);
    assert.equal(dispWidth('NAME'), 4);
    assert.equal(dispWidth('a中b'), 4);
  });
});

describe('truncate（按显示宽度）', () => {
  it('不超宽原样返回', () => {
    assert.equal(truncate('short', 48), 'short');
  });
  it('超宽截断且不溢出列、以 … 收尾', () => {
    const out = truncate('中'.repeat(100), 48);
    assert.ok(dispWidth(out) <= 48, `截断后显示宽度应 ≤ 48,实得 ${dispWidth(out)}`);
    assert.ok(out.endsWith('…'), '以省略号收尾');
  });
});

describe('renderTable 状态符不变量', () => {
  it('reachable + stale → `stale ⚠️`', () => {
    const line = dataLine(row({ state: 'stale', drifted: true, reachable: true }));
    assert.ok(line.includes('stale ⚠️'), `stale 行应显示 ⚠️:${line}`);
  });

  it('reachable + measurable → 裸 state,无 ? 无 ⚠️', () => {
    const line = dataLine(row({ state: 'measurable', reachable: true, currentEvidenceCount: 1, totalEvidenceCount: 1 }));
    assert.ok(line.includes('measurable'));
    assert.ok(!line.includes('?'), '可达非 stale 不应有 ?');
    assert.ok(!line.includes('⚠️'), '可达非 stale 不应有 ⚠️');
  });

  it('不可达 → `state ?`,绝不出现 ⚠️（不冒充 stale）', () => {
    const line = dataLine(row({ state: 'installed', reachable: false }));
    assert.ok(line.includes('installed ?'), `不可达应标 ?:${line}`);
    assert.ok(!line.includes('⚠️'), '不可达绝不冒充 stale ⚠️');
  });

  it('不可达即便内部 state 仍是 stale 也只标 ?,不标 ⚠️（守住「未核 ≠ 已漂移」）', () => {
    // buildManagedListRow 在不可达时本就不会给 stale,这里直接喂 stale 锁住 renderTable 这一层的兜底。
    const line = dataLine(row({ state: 'stale', reachable: false }));
    assert.ok(line.includes('stale ?'));
    assert.ok(!line.includes('⚠️'));
  });
});

describe('renderTable name 截断', () => {
  it('超长 name 被按显示宽度截断,不撑爆表宽', () => {
    const out = renderTable([row({ name: 'x'.repeat(120) })], 'en');
    assert.ok(out.includes('…'), '超长 name 应截断');
    assert.ok(!out.includes('x'.repeat(41)), 'name 列不应原样铺出 41+ 字符');
  });
});
