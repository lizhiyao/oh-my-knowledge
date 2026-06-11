/**
 * 受管决策史渲染 snapshot（zh / en × 列表 / 时间线）。固定 fixture + 时间戳 normalize 让跨机器稳定。
 * 改这两个渲染函数若动到非预期处,snapshot 会红 —— 先 review diff 再 vitest -u（AGENTS.md）。
 */
import { describe, it, expect } from 'vitest';
import { renderManagedList, renderManagedHistory } from '../../src/renderer/managed-history-renderer.js';
import { buildManagedListRows } from '../../src/managed/index.js';
import type { Lang, ManagedArtifactRecord } from '../../src/types/index.js';

// 只快照 <main> 结构块:剥掉 layout 全局壳与 CSS（在别处测）—— 快照聚焦受管渲染的结构/文案,
// 且不被 layout.ts 的样式改动无端弄红。时间戳归一化跨机器稳定。
function normalizeForSnapshot(html: string): string {
  const m = html.match(/<main[\s\S]*?<\/main>/);
  return (m ? m[0] : html)
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?/g, '[TIMESTAMP]')
    .replace(/[ \t]+$/gm, '');
}

// install + 两个内容版本(hashV1 NOISE → hashV2 PROGRESS)的证据 + promote(hashV2) + 一条带 override 的 rollback。
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
    { reportId: 'evolve-review-001', contentHash: 'hashV1contenthashlong', recordedAt: '2026-03-02T00:00:00.000Z', verdict: 'NOISE', sampleCoverage: { count: 6, hash: 'sh1' }, comparability: { cliVersion: '0.37.0' } },
    { reportId: 'evolve-review-002', contentHash: 'hashV2contenthashlong', recordedAt: '2026-03-05T00:00:00.000Z', verdict: 'PROGRESS', sampleCoverage: { count: 6, hash: 'sh2' }, comparability: { cliVersion: '0.37.0' } },
  ],
  decisions: [
    { decisionKind: 'promote', actor: 'alice', decidedAt: '2026-03-06T00:00:00.000Z', contentHash: 'hashV2contenthashlong', reportId: 'evolve-review-002', reason: '已人工复核' },
    { decisionKind: 'rollback', actor: 'bob', decidedAt: '2026-03-08T00:00:00.000Z', contentHash: 'hashV2contenthashlong', override: { verdict: 'PROGRESS', overriddenBlocks: ['drifted'] } },
  ],
};

const ROWS = buildManagedListRows([RECORD], () => ({ reachable: true, hash: 'hashV2contenthashlong' }));

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
  it('renderManagedHistory zh', () => {
    expect(normalizeForSnapshot(renderManagedHistory(RECORD, 'zh' as Lang))).toMatchSnapshot();
  });
  it('renderManagedHistory en', () => {
    expect(normalizeForSnapshot(renderManagedHistory(RECORD, 'en' as Lang))).toMatchSnapshot();
  });
});
