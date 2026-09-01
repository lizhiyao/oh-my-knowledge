/**
 * 受管决策史渲染 snapshot（zh / en × 列表 / 时间线）。固定 fixture + 时间戳 normalize 让跨机器稳定。
 * 改这两个渲染函数若动到非预期处,snapshot 会红 —— 先 review diff 再 vitest -u（AGENTS.md）。
 */
import { describe, it, expect } from 'vitest';
import { renderManagedList, renderManagedHistory } from '../../src/renderer/managed-history-renderer.js';
import { buildManagedListRows, type ManagedListRow } from '../../src/managed/index.js';
import type { Lang, ManagedArtifactRecord } from '../../src/types/index.js';
import { coreManagedEvidence } from '../helpers/core-managed-evidence.js';

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
  schemaVersion: 3,
  id: 'skill-review-fixture',
  name: 'review',
  kind: 'skill',
  source: { sourceKind: 'git', locator: 'git+https://example.com/r@abc123:review', url: 'https://example.com/r', ref: 'abc123', isDirectorySkill: true },
  contentHash: 'hashV2contenthashlong',
  installedAt: '2026-03-01T00:00:00.000Z',
  distribution: [],
  evidence: [
    coreManagedEvidence('hashV0contenthashlong', { reportId: 'evolve-review-000', recordedAt: '2026-03-01T12:00:00.000Z', verdict: 'INCONCLUSIVE' }),
    coreManagedEvidence('hashV1contenthashlong', { reportId: 'evolve-review-001', recordedAt: '2026-03-02T00:00:00.000Z', verdict: 'NOISE', sampleCoverage: { count: 6, hash: 'sh1' } }),
    coreManagedEvidence('hashV2contenthashlong', { reportId: 'evolve-review-002', recordedAt: '2026-03-05T00:00:00.000Z', verdict: 'PROGRESS', sampleCoverage: { count: 6, hash: 'sh2' } }),
  ],
  decisions: [
    { decisionKind: 'promote', actor: 'alice', decidedAt: '2026-03-06T00:00:00.000Z', contentHash: 'hashV2contenthashlong', runId: 'evolve-review-002', reason: '已人工复核' },
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
  mkRow({ id: 'i-over', name: 'override-skill', state: 'promoted', latestVerdict: 'CAUTIOUS', override: { verdict: 'CAUTIOUS', overriddenBlocks: ['drifted', 'verdict_blocked'] } }),
];

// observe 观测(#235)三条覆盖渲染分支:red+高(生产盲区徽标 + 盲区区域 + 补样本提示)、underpowered(数据
// 不足带标)、green(健康带标)。三条 observedAt 各异且**无 contentHash** —— 用来锁「观测事件不重置版本分段」。
const OBSERVE_RECORD: ManagedArtifactRecord = {
  ...RECORD,
  id: 'skill-observe-fixture',
  observations: [
    { observationKind: 'production-health', reportId: 'obs-red', observedAt: '2026-03-09T00:00:00.000Z', gapRate: 0.42, weightedGapRate: 0.42, confidence: 'high', healthBand: 'red', segmentCount: 80, gapByType: { failed_search: 5, explicit_marker: 2, hedging: 1, repeated_failure: 0 } },
    { observationKind: 'production-health', reportId: 'obs-yellow', observedAt: '2026-03-06T12:00:00.000Z', gapRate: 0.18, weightedGapRate: 0.18, confidence: 'high', healthBand: 'yellow', segmentCount: 70, gapByType: { failed_search: 2, explicit_marker: 0, hedging: 1, repeated_failure: 0 } },
    { observationKind: 'production-health', reportId: 'obs-weak', observedAt: '2026-03-04T00:00:00.000Z', gapRate: 0.5, weightedGapRate: 0.5, confidence: 'underpowered', healthBand: 'red', segmentCount: 2, gapByType: { failed_search: 1, explicit_marker: 0, hedging: 0, repeated_failure: 0 } },
    { observationKind: 'production-health', reportId: 'obs-green', observedAt: '2026-03-03T00:00:00.000Z', gapRate: 0.02, weightedGapRate: 0.02, confidence: 'high', healthBand: 'green', segmentCount: 90, gapByType: { failed_search: 0, explicit_marker: 0, hedging: 0, repeated_failure: 0 } },
  ],
};

// 列表生产盲区徽标 + legend:一行带 productionGap(确诊盲区,latest-wins 由 list-view 派生,这里直接构造)。
const GAP_ROWS: ManagedListRow[] = [
  mkRow({ id: 'i-gap', name: 'gap-skill', state: 'measurable', latestVerdict: 'PROGRESS',
    productionGap: { healthBand: 'red', confidence: 'high', gapByType: { failed_search: 4, explicit_marker: 1, hedging: 0, repeated_failure: 0 } } }),
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
  it('Core evidence 与决定链接使用 runId，而不是 reportId', () => {
    const record: ManagedArtifactRecord = {
      ...RECORD,
      evidence: [coreManagedEvidence('hashV2contenthashlong', {
        runId: 'core-run-route',
        reportId: 'core-run-route.report',
      })],
      decisions: [{
        decisionKind: 'promote',
        actor: 'alice',
        decidedAt: '2026-03-06T00:00:00.000Z',
        contentHash: 'hashV2contenthashlong',
        runId: 'core-run-route',
      }],
    };
    const html = renderManagedHistory(record, 'zh' as Lang);
    expect(html).toContain('/reports/core-run-route');
    expect(html).not.toContain('/reports/core-run-route.report');
  });
  // ── observe 生产健康观测时间线 + 列表徽标(#235)──
  it('renderManagedHistory 带 observe 观测(生产盲区 / 数据不足 / 健康)zh', () => {
    expect(normalizeForSnapshot(renderManagedHistory(OBSERVE_RECORD, 'zh' as Lang))).toMatchSnapshot();
  });
  it('renderManagedHistory 带 observe 观测 en', () => {
    expect(normalizeForSnapshot(renderManagedHistory(OBSERVE_RECORD, 'en' as Lang))).toMatchSnapshot();
  });
  it('renderManagedList 生产盲区徽标 + legend zh', () => {
    expect(normalizeForSnapshot(renderManagedList(GAP_ROWS, 'zh' as Lang))).toMatchSnapshot();
  });
  it('renderManagedList 生产盲区徽标 en', () => {
    expect(normalizeForSnapshot(renderManagedList(GAP_ROWS, 'en' as Lang))).toMatchSnapshot();
  });

  // 回归:yellow 观测绝不渲染成「健康」/ 绿点(yellow 是注意区间、非健康)。red 仍是盲区红点。
  it('yellow 观测渲染为「需关注」+ 黄点,不冒充健康/绿点', () => {
    const zh = renderManagedHistory(OBSERVE_RECORD, 'zh' as Lang);
    expect(zh).toContain('<span class="mh-watch">需关注</span>');
    expect(zh).toContain('mh-dot--yellow');
    // green 观测才是「健康」+ 绿点;yellow 不该混进去。
    expect(zh).toContain('<span class="mh-badge-raw">健康</span>');
    const en = renderManagedHistory(OBSERVE_RECORD, 'en' as Lang);
    expect(en).toContain('<span class="mh-watch">elevated</span>');
  });

  // 承重不变量:observe 事件无 contentHash → 绝不新增版本段头。加了观测后 `mh-vhead` 数量应与无观测时相同。
  it('observe 观测不重置版本分段(版本段头数量不变)', () => {
    const headers = (html: string): number => (html.match(/mh-vhead/g) ?? []).length;
    const withObs = renderManagedHistory(OBSERVE_RECORD, 'zh' as Lang);
    const withoutObs = renderManagedHistory(RECORD, 'zh' as Lang);
    expect(headers(withObs)).toBe(headers(withoutObs));
    // 且观测确实进了时间线(渲染出 observe 事件)。
    expect(withObs).toContain('mh-event--observe');
  });
});
