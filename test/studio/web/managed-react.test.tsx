/**
 * 受管列表与决策史在 React 的呈现口径，迁移自被删除的 managed-history-renderer 快照测试。
 *
 * 快照换成按语义逐条断言：生命周期五态各自的本地化文字、未核／漂移／生产盲区三个标记、
 * observe 强弱四档、版本分段不变量，以及 Core run 深链用 runId 而不是 reportId。
 * 派生逻辑本身（state / productionGap / latest-wins）在 governance 侧测，这里只锁「读起来是什么」。
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it } from 'vitest';
import type { ManagedListRow } from '../../../src/knowledge-artifacts/governance/index.js';
import type { ManagedArtifactRecord, ManagedObservation } from '../../../src/knowledge-artifacts/governance/contracts.js';
import { projectManagedListRow, projectManagedTimeline } from '../../../src/studio/application/knowledge/managed-format';
import type { ManagedPage } from '../../../src/studio/http/pages/managed-page';
import { ManagedHistoryView, ManagedListView } from '../../../src/studio/web/components/knowledge/managed';
import { coreManagedEvidence } from '../../helpers/core-managed-evidence.js';
import { reactText, visibleText } from '../../helpers/react-ssr.js';

type Lang = 'zh' | 'en';

/** 图例在表格外，按行计数要先剥出表体。 */
function tableBody(html: string): string {
  const body = /<tbody[\s\S]*?<\/tbody>/u.exec(html)?.[0];
  assert.ok(body, 'managed table body');
  return body ?? '';
}

/** 时间线上实际渲染出的版本头：短 hash ＋ 是否标了「当前」。分段口径要靠序列锁，不能只数出现次数。 */
function versionHeads(html: string): Array<{ hash: string; current: boolean }> {
  return [...html.matchAll(/版本<\/span><code class="measure-code">([^<]+)<\/code>([\s\S]*?)<\/div>/gu)]
    .map(([, hash, tail]) => ({ hash, current: tail.includes('当前') }));
}

function renderList(rows: ManagedListRow[], lang: Lang): string {
  const page: Extract<ManagedPage, { pageKind: 'list' }> = { pageKind: 'list', rows: rows.map(projectManagedListRow) };
  return visibleText(renderToString(createElement(ManagedListView, { page, lang })));
}

function renderHistory(record: ManagedArtifactRecord, lang: Lang): string {
  const page: Extract<ManagedPage, { pageKind: 'detail' }> = {
    pageKind: 'detail',
    name: record.name,
    artifactKind: record.kind,
    sourceKind: record.source.sourceKind,
    contentHash: record.contentHash,
    installedAt: record.installedAt,
    segments: projectManagedTimeline(record),
  };
  return visibleText(renderToString(createElement(ManagedHistoryView, { page, lang })));
}

const V0 = 'hashV0contenthashlong';
const V1 = 'hashV1contenthashlong';
const V2 = 'hashV2contenthashlong';

/** 三个内容版本的证据 + 全部决定类型，刻意覆盖每条呈现分支（与退役前的同名 fixture 同形状）。 */
const RECORD: ManagedArtifactRecord = {
  recordKind: 'managed-artifact',
  schemaVersion: 3,
  id: 'skill-review-fixture',
  name: 'review',
  kind: 'skill',
  source: { sourceKind: 'git', locator: `git+https://example.com/r@abc123:review`, url: 'https://example.com/r', ref: 'abc123', isDirectorySkill: true },
  contentHash: V2,
  installedAt: '2026-03-01T00:00:00.000Z',
  distribution: [],
  evidence: [
    coreManagedEvidence(V0, { reportId: 'evolve-review-000', recordedAt: '2026-03-01T12:00:00.000Z', verdict: 'INCONCLUSIVE' }),
    coreManagedEvidence(V1, { reportId: 'evolve-review-001', recordedAt: '2026-03-02T00:00:00.000Z', verdict: 'NOISE', sampleCoverage: { count: 6, hash: `sha256:${'1'.repeat(64)}` } }),
    coreManagedEvidence(V2, { reportId: 'evolve-review-002', recordedAt: '2026-03-05T00:00:00.000Z', verdict: 'PROGRESS', sampleCoverage: { count: 6, hash: `sha256:${'2'.repeat(64)}` } }),
  ],
  decisions: [
    { decisionKind: 'promote', actor: 'alice', decidedAt: '2026-03-06T00:00:00.000Z', contentHash: V2, runId: 'evolve-review-002', reason: '已人工复核' },
    { decisionKind: 'reject', actor: 'carol', decidedAt: '2026-03-07T00:00:00.000Z', contentHash: V1 },
    { decisionKind: 'rollback', actor: 'bob', decidedAt: '2026-03-08T00:00:00.000Z', contentHash: V2, override: { verdict: 'PROGRESS', overriddenBlocks: ['drifted'] } },
  ],
};

function observation(over: Partial<ManagedObservation> = {}): ManagedObservation {
  return {
    observationKind: 'production-health', reportId: 'obs-1', observedAt: '2026-03-09T00:00:00.000Z',
    gapRate: 0.42, weightedGapRate: 0.42, confidence: 'high', healthBand: 'red', segmentCount: 80,
    gapByType: { failed_search: 5, explicit_marker: 2, hedging: 1, repeated_failure: 0 }, ...over,
  };
}

/** 带四档 observe 强弱的历史记录：红＋够力、yellow、underpowered（虽红但样本不足）、green。 */
const OBSERVE_RECORD: ManagedArtifactRecord = {
  ...RECORD,
  id: 'skill-observe-fixture',
  observations: [
    observation(),
    observation({ reportId: 'obs-yellow', observedAt: '2026-03-06T12:00:00.000Z', healthBand: 'yellow', gapRate: 0.18, weightedGapRate: 0.18, gapByType: { failed_search: 2, explicit_marker: 0, hedging: 1, repeated_failure: 0 } }),
    observation({ reportId: 'obs-weak', observedAt: '2026-03-04T00:00:00.000Z', confidence: 'underpowered', segmentCount: 2, gapRate: 0.5, weightedGapRate: 0.5, gapByType: { failed_search: 1, explicit_marker: 0, hedging: 0, repeated_failure: 0 } }),
    observation({ reportId: 'obs-green', observedAt: '2026-03-03T00:00:00.000Z', healthBand: 'green', gapRate: 0.02, weightedGapRate: 0.02, gapByType: { failed_search: 0, explicit_marker: 0, hedging: 0, repeated_failure: 0 } }),
  ],
};

const ROW = (over: Partial<ManagedListRow>): ManagedListRow => ({
  id: 'id', name: 'x', kind: 'skill', sourceKind: 'git', sourceLabel: 'https://example.com/r',
  state: 'measurable', drifted: false, reachable: true,
  currentEvidenceCount: 1, totalEvidenceCount: 1, distributionCount: 0, ...over,
});

describe('受管列表呈现', () => {
  it('五个生命周期状态各自读法不同，未知 token 不静默降级', () => {
    const zh = renderList([
      ROW({ id: 'i-prom', name: 'promoted-skill', state: 'promoted', latestVerdict: 'PROGRESS' }),
      ROW({ id: 'i-meas', name: 'measurable-skill', state: 'measurable', latestVerdict: 'CAUTIOUS' }),
      ROW({ id: 'i-inst', name: 'installed-skill', state: 'installed', currentEvidenceCount: 0, totalEvidenceCount: 0 }),
      ROW({ id: 'i-stale', name: 'stale-skill', state: 'stale', drifted: true, currentEvidenceCount: 0 }),
      ROW({ id: 'i-unre', name: 'unreachable-skill', state: 'discovered', reachable: false }),
    ], 'zh');
    for (const label of ['已采用', '证据就绪', '已纳管', '已漂移', '已发现']) {
      assert.ok(zh.includes(label), `state label ${label}`);
    }
    // 漂移与「源未核」是两个不同的未知：前者 ⚠️，后者 ?。
    assert.match(zh, /<span aria-hidden="true">⚠️<\/span>/);
    assert.match(zh, /<span class="managed-mark">\?<\/span>/);
    const en = renderList([ROW({ state: 'promoted' }), ROW({ state: 'measurable' }), ROW({ state: 'installed' }), ROW({ state: 'stale' }), ROW({ state: 'discovered' })], 'en');
    for (const label of ['Promoted', 'Measurable', 'Installed', 'Drifted', 'Discovered']) {
      assert.ok(en.includes(label), `en state label ${label}`);
    }
  });

  it('verdict 与越门采用原样呈现 Core 认证的值，证据列是当前／全部', () => {
    const html = renderList([ROW({
      state: 'promoted', latestVerdict: 'CAUTIOUS',
      override: { verdict: 'CAUTIOUS', overriddenBlocks: ['drifted', 'verdict_blocked'] },
      currentEvidenceCount: 2, totalEvidenceCount: 5,
    })], 'zh');
    assert.match(html, /managed-verdict[^>]*>CAUTIOUS</);
    assert.match(html, />越门</);
    assert.match(html, /<span class="managed-count">2\/5<\/span>/);
    // 越门绕过了哪几道门禁只在悬停提示里，图例必须独立可读。
    assert.match(html, /class="managed-legend"/);
  });

  it('生产盲区标记与生命周期正交：红＋够力才标 🔬', () => {
    const html = renderList([
      ROW({ id: 'i-gap', name: 'gap-skill', productionGap: { healthBand: 'red', confidence: 'high', gapByType: { failed_search: 4, explicit_marker: 1, hedging: 0, repeated_failure: 0 } } }),
      ROW({ id: 'i-clean', name: 'clean-skill' }),
    ], 'zh');
    assert.equal((tableBody(html).match(/🔬/g) ?? []).length, 1);
    assert.match(html, /生产盲区/);
  });

  it('无受管记录时给出下一步命令，而不是空表格', () => {
    const zh = renderList([], 'zh');
    assert.match(zh, /omk install/);
    assert.match(zh, /暂无受管 skill/);
    assert.match(renderList([], 'en'), /No managed skills yet/);
  });

  it('外部文本按 React 口径转义，不拼进原始 HTML', () => {
    const payload = '<script>alert(1)</script>';
    const html = renderList([ROW({ name: payload, sourceLabel: payload })], 'zh');
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.ok(html.includes(reactText(payload)), '转义后仍需可见');
  });
});

describe('受管决策史呈现', () => {
  it('按内容版本分段，当前版本可辨认，旧版本仍可回滚', () => {
    const zh = renderHistory(RECORD, 'zh');
    const heads = versionHeads(zh);
    // 分段口径是「时间序里内容版本变化处」，不是「每个内容版本一段」：回滚把 V2 重新成段，旧版本才读得出可回滚。
    assert.deepEqual(heads.map((head) => head.hash), [V2, V1, V2, V1, V0].map((hash) => reactText(hash.slice(0, 12))));
    assert.deepEqual(heads.map((head) => head.current), [true, false, true, false, false], '当前只标等于记录基线 hash 的那几段');
    assert.match(zh, /纳管于 2026-03-01 00:00:00 UTC/);
  });

  it('事件行带决定人、理由、用例数与越门标记，时刻显式 UTC', () => {
    const zh = renderHistory(RECORD, 'zh');
    assert.match(zh, /决定人 alice/);
    assert.match(zh, /「已人工复核」/);
    assert.match(zh, /6 用例/);
    assert.match(zh, /越门/);
    assert.match(zh, /否决/);
    assert.match(zh, /2026-03-05 00:00:00 UTC/);
    assert.doesNotMatch(zh, /2026-03-07T00:00:00/);
    const en = renderHistory(RECORD, 'en');
    for (const label of ['Installed', 'Eval', 'Promote', 'Reject', 'Rollback', 'by alice']) {
      assert.ok(en.includes(label), `en event label ${label}`);
    }
  });

  it('Core 深链用 runId，而不是 reportId', () => {
    const record: ManagedArtifactRecord = {
      ...RECORD,
      evidence: [coreManagedEvidence(V2, { runId: 'core-run-route', reportId: 'core-run-route.report' })],
      decisions: [{ decisionKind: 'promote', actor: 'alice', decidedAt: '2026-03-06T00:00:00.000Z', contentHash: V2, runId: 'core-run-route' }],
    };
    const html = renderHistory(record, 'zh');
    assert.match(html, /href="\/measure\/core-run-route"/);
    assert.doesNotMatch(html, /\/measure\/core-run-route\.report/);
  });

  it('observe 不重置版本分段：加了观测后分段序列不变', () => {
    assert.deepEqual(versionHeads(renderHistory(OBSERVE_RECORD, 'zh')), versionHeads(renderHistory(RECORD, 'zh')));
    assert.match(renderHistory(OBSERVE_RECORD, 'zh'), /观测/);
  });

  it('observe 四档强弱各读各的，yellow 不冒充健康、underpowered 优先于色带', () => {
    const zh = renderHistory(OBSERVE_RECORD, 'zh');
    assert.match(zh, />生产盲区</);
    assert.match(zh, />需关注</);
    assert.match(zh, />数据不足</);
    assert.match(zh, />健康</);
    const en = renderHistory(OBSERVE_RECORD, 'en');
    for (const badge of ['production gap', 'elevated', 'underpowered', 'healthy']) {
      assert.ok(en.includes(badge), `en observe badge ${badge}`);
    }
    // underpowered 那条本身是红带：只能读作「数据不足」，不得同时给出确诊盲区结论。
    const weak = OBSERVE_RECORD.observations!.filter((item) => item.reportId === 'obs-weak');
    const onlyWeak = renderHistory({ ...OBSERVE_RECORD, observations: weak }, 'zh');
    assert.match(onlyWeak, />数据不足</);
    assert.doesNotMatch(onlyWeak, />生产盲区</);
  });

  it('盲区集中在哪几类信号按计数降序给出，并提示补样本重跑', () => {
    const zh = renderHistory(OBSERVE_RECORD, 'zh');
    const order = ['检索失败', '显式缺口', '含糊回避'].map((label) => zh.indexOf(label));
    assert.deepEqual(order, [...order].sort((left, right) => left - right), '按计数降序');
    assert.match(zh, /建议补对应用例后重跑 omk eval/);
    // 四类已知信号同分时只给前三：第四类被截断，而不是把整行挤掉。
    const fourWay = renderHistory({
      ...OBSERVE_RECORD,
      observations: [observation({ gapByType: {
        failed_search: 1, explicit_marker: 1, hedging: 1, repeated_failure: 1,
      } })],
    }, 'zh');
    assert.equal(['检索失败', '显式缺口', '含糊回避', '反复失败'].filter((label) => fourWay.includes(label)).length, 3);
  });

  it('外部文本按 React 口径转义', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const html = renderHistory({
      ...RECORD,
      name: payload,
      decisions: [{ decisionKind: 'promote', actor: payload, decidedAt: '2026-03-06T00:00:00.000Z', contentHash: V2, reason: payload }],
    }, 'zh');
    assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
    assert.ok(html.includes(reactText(payload)), '转义后仍需可见');
  });
});
