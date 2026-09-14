/**
 * 受管决策史的呈现口径投影。
 *
 * 时间线分段、观测事件强弱、状态色带、盲区区域排序都是「同一个数在列表／详情／图例里必须读成同一种颜色」
 * 的口径，放在这里一处算完，React 树只取标签文字与色调，不重新判断健康度 —— 与 application/observe/health-format.ts
 * 同一条边界。词汇（zh/en 措辞）留在组件里，本模块只输出枚举与计数。
 */
import type {
  ManagedArtifactRecord,
  ManagedDecisionKind,
  ManagedObservation,
} from '../../../knowledge-artifacts/governance/contracts.js';
import type { ManagedListRow } from '../../../knowledge-artifacts/governance/list-view.js';

/** 与 health-format 同色的四档呈现色调；muted 表示「无信号」，不是负面。 */
export type ManagedTone = 'green' | 'yellow' | 'red' | 'accent' | 'muted';

/** observe 事件强弱：红 + 够力才是确诊生产盲区；yellow 不能读作健康；underpowered 优先于色带。 */
export type ManagedObserveBadge = 'production_gap' | 'underpowered' | 'elevated' | 'healthy';

/** 知识缺口信号类型（与观测侧四类信号同名，额外键不进展示）。 */
export type ManagedGapSignalType = keyof ManagedObservation['gapByType'];

export interface ManagedGapArea {
  signalType: ManagedGapSignalType;
  count: number;
}

export interface ManagedTimelineEvent {
  eventKind: 'install' | 'eval' | ManagedDecisionKind | 'observe';
  at: string;
  contentHash?: string;
  verdict?: string;
  /** Studio 的 Core 详情路由以 runId 为主键，不是 reportId。 */
  runId?: string;
  actor?: string;
  reason?: string;
  overriddenBlocks?: string[];
  sampleCount?: number;
  observeBadge?: ManagedObserveBadge;
  gapAreas?: ManagedGapArea[];
}

/** 一段内容版本的事件；contentHash 为 null 表示尚未出现版本头（安装与版本无关观测）。 */
export interface ManagedVersionSegment {
  contentHash: string | null;
  isCurrent: boolean;
  events: ManagedTimelineEvent[];
}

export interface ManagedListPresentation {
  row: ManagedListRow;
  tone: ManagedTone;
  gapAreas: ManagedGapArea[];
}

const GAP_SIGNAL_TYPES: readonly ManagedGapSignalType[] = [
  'failed_search',
  'explicit_marker',
  'hedging',
  'repeated_failure',
];

/** 时刻排序：两端都能解析就按真实时刻，否则退字典序 —— 与治理侧 latestCurrentEvidence 同口径。 */
function compareDesc(a: string, b: string): number {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (!Number.isNaN(left) && !Number.isNaN(right)) return right - left;
  return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * 只迭代四个已知信号类型：记录被手改塞进额外键时忽略它，比让整条记录在校验处丢掉更稳。
 * 计数降序取前三，全 0 返回空数组（调用方据此略过整行）。
 */
export function projectGapAreas(gapByType: Partial<Record<string, number>> | undefined): ManagedGapArea[] {
  if (!gapByType) return [];
  return GAP_SIGNAL_TYPES
    .map((signalType) => ({ signalType, count: gapByType[signalType] ?? 0 }))
    .filter((area) => area.count > 0)
    .sort((left, right) => right.count - left.count)
    .slice(0, 3);
}

/** underpowered 先于色带：样本不足时任何 band 都只能读作「未知」，与 deriveProductionGap 同口径。 */
export function projectObserveBadge(
  observation: Pick<ManagedObservation, 'healthBand' | 'confidence'>,
): ManagedObserveBadge {
  if (observation.confidence === 'underpowered') return 'underpowered';
  if (observation.healthBand === 'red') return 'production_gap';
  if (observation.healthBand === 'yellow') return 'elevated';
  return 'healthy';
}

/** 生命周期状态 → 色调。未知 token 归 muted（非法状态由校验层拦下，这里只保证不崩）。 */
export function managedStateTone(state: string): ManagedTone {
  if (state === 'promoted') return 'green';
  if (state === 'stale') return 'red';
  if (state === 'measurable') return 'accent';
  return 'muted';
}

export function projectManagedListRow(row: ManagedListRow): ManagedListPresentation {
  return {
    row,
    tone: managedStateTone(row.state),
    gapAreas: row.productionGap ? projectGapAreas(row.productionGap.gapByType) : [],
  };
}

function collectEvents(record: ManagedArtifactRecord): ManagedTimelineEvent[] {
  // install 不带 contentHash：record.contentHash 是「当前基线」（evolve 会 re-baseline），
  // 拿它标安装事件会误导，故安装只作时间起点，版本分段只用 evidence / decision 自带的 hash。
  const events: ManagedTimelineEvent[] = [
    { eventKind: 'install', at: record.installedAt },
    ...record.evidence.map((item) => ({
      eventKind: 'eval' as const,
      at: item.recordedAt,
      contentHash: item.contentHash,
      verdict: item.verdict,
      runId: item.runId,
      sampleCount: item.sampleCoverage.count,
    })),
    ...record.decisions.map((decision) => ({
      eventKind: decision.decisionKind,
      at: decision.decidedAt,
      contentHash: decision.contentHash,
      runId: decision.runId,
      actor: decision.actor,
      reason: decision.reason,
      overriddenBlocks: decision.override?.overriddenBlocks,
    })),
    // observe 是版本无关的生产信号：不参与版本分段，只按自身健康度定强弱。
    ...(record.observations ?? []).map((observation) => ({
      eventKind: 'observe' as const,
      at: observation.observedAt,
      observeBadge: projectObserveBadge(observation),
      gapAreas: projectGapAreas(observation.gapByType),
    })),
  ];
  return events.sort((left, right) => compareDesc(left.at, right.at));
}

/**
 * 倒序遍历：内容版本变化处开新段；无 hash 的事件落进它当时所处的段，
 * 因此安装事件与版本无关观测会跟在最近的版本头下面，而不是各自成段。
 */
export function projectManagedTimeline(record: ManagedArtifactRecord): ManagedVersionSegment[] {
  const segments: ManagedVersionSegment[] = [];
  let previousHash: string | undefined;
  for (const event of collectEvents(record)) {
    if (event.contentHash && event.contentHash !== previousHash) {
      segments.push({
        contentHash: event.contentHash,
        isCurrent: event.contentHash === record.contentHash,
        events: [event],
      });
      previousHash = event.contentHash;
      continue;
    }
    // 到这里只剩两种情况：事件带 hash 且与上一段同版本，或还没有任何段（安装早于首次取证）。
    const current = segments.at(-1);
    if (current) {
      current.events.push(event);
      continue;
    }
    segments.push({ contentHash: null, isCurrent: false, events: [event] });
  }
  return segments;
}
