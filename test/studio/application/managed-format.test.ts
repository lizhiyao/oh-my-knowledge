/**
 * 受管决策史的呈现口径：状态色带、盲区信号取前三、时间线分段。
 *
 * 这些决定了「同一行记录在列表／详情／图例里读成同一种颜色」，与 React 的措辞无关，
 * 所以在 application 层锁；页面能渲染出什么由 web/managed-react.test.tsx 负责。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { ManagedArtifactRecord, ManagedObservation } from '../../../src/knowledge-artifacts/governance/contracts.js';
import type { ManagedListRow } from '../../../src/knowledge-artifacts/governance/index.js';
import {
  projectGapAreas,
  projectManagedListRow,
  projectManagedTimeline,
  projectObserveBadge,
} from '../../../src/studio/application/knowledge/managed-format.js';
import { coreManagedEvidence } from '../../helpers/core-managed-evidence.js';

const ROW = (over: Partial<ManagedListRow>): ManagedListRow => ({
  id: 'id', name: 'x', kind: 'skill', sourceKind: 'git', sourceLabel: 'https://example.com/r',
  state: 'measurable', drifted: false, reachable: true,
  currentEvidenceCount: 1, totalEvidenceCount: 1, distributionCount: 0, ...over,
});

describe('受管列表行投影', () => {
  it('productionGap 缺 gapByType 计数时仍标盲区，不编造盲区区域', () => {
    const presentation = projectManagedListRow(ROW({
      productionGap: { healthBand: 'red', confidence: 'high', gapByType: { failed_search: 0, explicit_marker: 0, hedging: 0, repeated_failure: 0 } },
    }));
    assert.equal(presentation.tone, 'accent');
    assert.deepEqual(presentation.gapAreas, []);
  });

  it('记录里手改出来的未知信号键不参与展示，也不挤掉已知信号', () => {
    const areas = projectGapAreas({
      failed_search: 1, explicit_marker: 2, hedging: 0, repeated_failure: 0, mystery: 99,
    } as ManagedObservation['gapByType']);
    assert.deepEqual(areas, [{ signalType: 'explicit_marker', count: 2 }, { signalType: 'failed_search', count: 1 }]);
  });

  it('underpowered 先于色带：样本不足的红不是确诊盲区', () => {
    assert.equal(projectObserveBadge({ healthBand: 'red', confidence: 'underpowered' }), 'underpowered');
    assert.equal(projectObserveBadge({ healthBand: 'red', confidence: 'low' }), 'production_gap');
    assert.equal(projectObserveBadge({ healthBand: 'yellow', confidence: 'high' }), 'elevated');
    assert.equal(projectObserveBadge({ healthBand: 'green', confidence: 'high' }), 'healthy');
  });
});

describe('时间线分段投影', () => {
  const record = (over: Partial<ManagedArtifactRecord> = {}): ManagedArtifactRecord => ({
    recordKind: 'managed-artifact',
    schemaVersion: 3,
    id: 'skill-x',
    name: 'x',
    kind: 'skill',
    source: { sourceKind: 'file', locator: '/tmp/x', isDirectorySkill: true },
    contentHash: 'hashB',
    installedAt: '2026-03-01T00:00:00.000Z',
    distribution: [],
    evidence: [
      coreManagedEvidence('hashA', { recordedAt: '2026-03-02T00:00:00.000Z' }),
      coreManagedEvidence('hashB', { recordedAt: '2026-03-03T00:00:00.000Z' }),
    ],
    decisions: [{ decisionKind: 'promote', actor: 'alice', decidedAt: '2026-03-04T00:00:00.000Z', contentHash: 'hashB' }],
    ...over,
  });

  it('新→旧排列，内容版本变化处才开新段，安装事件跟在它当时所处的段里', () => {
    const segments = projectManagedTimeline(record());
    assert.deepEqual(segments.map((segment) => segment.contentHash), ['hashB', 'hashA']);
    assert.deepEqual(segments.map((segment) => segment.isCurrent), [true, false]);
    assert.deepEqual(segments.map((segment) => segment.events.map((event) => event.eventKind)), [
      ['promote', 'eval'], ['eval', 'install'],
    ]);
  });

  it('同一版本连续多个事件只成一段，回滚到旧内容会再开一段', () => {
    const rollback = record({
      contentHash: 'hashA',
      decisions: [
        { decisionKind: 'promote', actor: 'alice', decidedAt: '2026-03-04T00:00:00.000Z', contentHash: 'hashB' },
        { decisionKind: 'rollback', actor: 'bob', decidedAt: '2026-03-05T00:00:00.000Z', contentHash: 'hashA' },
      ],
    });
    const segments = projectManagedTimeline(rollback);
    assert.deepEqual(segments.map((segment) => segment.contentHash), ['hashA', 'hashB', 'hashA']);
    // 「当前」是逐段与记录基线比对的结果，不是「最后一段」：回滚后两段同内容 hash 的段都读作当前。
    assert.deepEqual(segments.map((segment) => segment.isCurrent), [true, false, true]);
  });

  it('尚未取证的受管记录只有一段无版本段，安装事件不冒充版本', () => {
    const fresh = record({ evidence: [], decisions: [] });
    const segments = projectManagedTimeline(fresh);
    assert.deepEqual(segments.map((segment) => segment.contentHash), [null]);
    assert.deepEqual(segments.map((segment) => segment.events.map((event) => event.eventKind)), [['install']]);
    assert.equal(segments[0].isCurrent, false, 'record.contentHash 是当前基线，不是安装事实');
  });
});
