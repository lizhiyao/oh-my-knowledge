/**
 * 受管决策史渲染 snapshot（zh / en × 列表 / 时间线）。固定 fixture + 时间戳 normalize 让跨机器稳定。
 * 改这两个渲染函数若动到非预期处,snapshot 会红 —— 先 review diff 再 vitest -u（AGENTS.md）。
 */
import { describe, it, expect } from 'vitest';
import { renderManagedList, renderManagedHistory } from '../../src/renderer/managed-history-renderer.js';
import { buildManagedListRows, type ManagedListRow } from '../../src/managed/index.js';
import type { Lang, ManagedArtifactRecord } from '../../src/types/index.js';

// 只快照 <main> 结构块:剥掉 layout 全局壳与 CSS（在别处测）—— 快照聚焦受管渲染的结构/文案,
// 且不被 layout.ts 的样式改动无端弄红。时间戳归一化跨机器稳定。
function normalizeForSnapshot(html: string): string {
  const m = html.match(/<main[\s\S]*?<\/main>/);
  return (m ? m[0] : html)
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?/g, '[TIMESTAMP]')
    .replace(/[ \t]+$/gm, '');
}

// 三个内容版本的证据 + 全部决定类型,刻意覆盖每条渲染分支:
//   - evidence[0] hashV0:未知 verdict(INCONCLUSIVE,非 VerdictLevel → mh-badge-raw 降级)+ 缺 sampleCoverage /
//     comparability(测 eventRow 的可选字段 if 守卫,无 sample 数 / omk 版本时不应渲染那两段);
//   - hashV1 NOISE → hashV2 PROGRESS:已知 verdict 走配色徽标;
//   - decisions:promote(带 reason)+ reject(缺 reason,测守卫 + dot--reject 配色)+ 带 override 的 rollback。
const RECORD: ManagedArtifactRecord = {
  recordKind: 'managed-artifact',
  schemaVersion: 2,
  id: 'skill-review-fixture',
  name: 'review',
  kind: 'skill',
  source: { sourceKind: 'git', locator: 'git+https://example.com/r@abc123:review', url: 'https://example.com/r', ref: 'abc123', isDirectorySkill: true },
  contentHash: 'hashV2contenthashlong',
  installedAt: '2026-03-01T00:00:00.000Z',
  distribution: [],
  evidence: [
    { reportId: 'evolve-review-000', contentHash: 'hashV0contenthashlong', recordedAt: '2026-03-01T12:00:00.000Z', verdict: 'INCONCLUSIVE' },
    { reportId: 'evolve-review-001', contentHash: 'hashV1contenthashlong', recordedAt: '2026-03-02T00:00:00.000Z', verdict: 'NOISE', sampleCoverage: { count: 6, hash: 'sh1' }, comparability: { cliVersion: '0.37.0' } },
    { reportId: 'evolve-review-002', contentHash: 'hashV2contenthashlong', recordedAt: '2026-03-05T00:00:00.000Z', verdict: 'PROGRESS', sampleCoverage: { count: 6, hash: 'sh2' }, comparability: { cliVersion: '0.37.0' } },
  ],
  decisions: [
    { decisionKind: 'promote', actor: 'alice', decidedAt: '2026-03-06T00:00:00.000Z', contentHash: 'hashV2contenthashlong', reportId: 'evolve-review-002', reason: '已人工复核' },
    { decisionKind: 'reject', actor: 'carol', decidedAt: '2026-03-07T00:00:00.000Z', contentHash: 'hashV1contenthashlong' },
    { decisionKind: 'rollback', actor: 'bob', decidedAt: '2026-03-08T00:00:00.000Z', contentHash: 'hashV2contenthashlong', override: { verdict: 'PROGRESS', overriddenBlocks: ['drifted'] } },
  ],
};

const ROWS = buildManagedListRows([RECORD], () => ({ reachable: true, hash: 'hashV2contenthashlong' }));

// 直接构造每个生命周期状态各一行,锁住 listRow 的本地化文案 + ? / ⚠️ 标记(派生逻辑在 list-view 测,这里只测渲染)。
const mkRow = (over: Partial<ManagedListRow>): ManagedListRow => ({
  id: 'id', name: 'x', kind: 'skill', sourceKind: 'git', sourceLabel: 'https://example.com/r',
  state: 'measurable', drifted: false, reachable: true,
  currentEvidenceCount: 1, totalEvidenceCount: 1, distributionCount: 0, ...over,
});
const STATE_ROWS: ManagedListRow[] = [
  mkRow({ id: 'i-prom', name: 'promoted-skill', state: 'promoted', latestVerdict: 'PROGRESS' }),
  mkRow({ id: 'i-meas', name: 'measurable-skill', state: 'measurable', latestVerdict: 'CAUTIOUS' }),
  mkRow({ id: 'i-inst', name: 'installed-skill', state: 'installed', currentEvidenceCount: 0, totalEvidenceCount: 0 }),
  mkRow({ id: 'i-stale', name: 'stale-skill', state: 'stale', drifted: true }),
  mkRow({ id: 'i-unre', name: 'unreachable-skill', state: 'measurable', reachable: false }),
  mkRow({ id: 'i-over', name: 'override-skill', state: 'promoted', latestVerdict: 'CAUTIOUS', override: { verdict: 'CAUTIOUS', overriddenBlocks: ['incomparable', 'verdict_blocked'] } }),
];

describe('managed-history-renderer snapshots', () => {
  it('renderManagedList zh', () => {
    expect(normalizeForSnapshot(renderManagedList(ROWS, 'zh' as Lang))).toMatchSnapshot();
  });
  it('renderManagedList en', () => {
    expect(normalizeForSnapshot(renderManagedList(ROWS, 'en' as Lang))).toMatchSnapshot();
  });
  it('renderManagedList empty zh', () => {
    expect(normalizeForSnapshot(renderManagedList([], 'zh' as Lang))).toMatchSnapshot();
  });
  it('renderManagedList 各状态 + 标记 zh', () => {
    expect(normalizeForSnapshot(renderManagedList(STATE_ROWS, 'zh' as Lang))).toMatchSnapshot();
  });
  it('renderManagedList 各状态 + 标记 en', () => {
    expect(normalizeForSnapshot(renderManagedList(STATE_ROWS, 'en' as Lang))).toMatchSnapshot();
  });
  it('renderManagedHistory zh', () => {
    expect(normalizeForSnapshot(renderManagedHistory(RECORD, 'zh' as Lang))).toMatchSnapshot();
  });
  it('renderManagedHistory en', () => {
    expect(normalizeForSnapshot(renderManagedHistory(RECORD, 'en' as Lang))).toMatchSnapshot();
  });
});
