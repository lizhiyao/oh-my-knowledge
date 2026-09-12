import { ownRecordValue } from '../../shared/record-count.js';
import type { TraceSourceKind } from '../contracts/trace.js';
import type { ObservationInboxItem } from '../contracts/inbox.js';
import type { ObservationInboxViewModel } from './view-model.js';

/**
 * Skill 观测看板的聚合逻辑（宿主无关纯函数，#839 批次 2）。
 * 从 presentation/observation-inbox/process-workspace-renderer 抽到数据层，
 * HTML 渲染器与 React 页面共用同一份聚合与排序语义，避免第二份业务口径。
 */

export interface SkillRollupMetricCounts {
  readonly bash: number;
  readonly read: number;
  readonly grep: number;
  readonly uncertainty: number;
  readonly explicitMarker: number;
  readonly bashProbe: number;
  readonly notFound: number;
  readonly toolLimit: number;
  readonly toolFailure: number;
}

export interface SkillRollupSeverityCounts {
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly noise: number;
}

export type SkillReviewTone = 'error' | 'warning' | 'neutral' | 'success';

export interface ObservationSkillRollup {
  readonly skillName: string;
  readonly invocationCount: number;
  readonly sessionCount: number;
  readonly observationCount: number;
  readonly counts: SkillRollupSeverityCounts;
  readonly lastProblemSeen: string;
  readonly lastUsed: string;
  readonly sources: readonly TraceSourceKind[];
  readonly metricCounts: SkillRollupMetricCounts;
  readonly reviewLabel: string;
  readonly reviewTone: SkillReviewTone;
}

type SkillRollupModel = Pick<
  ObservationInboxViewModel,
  'allItems' | 'skillInvocationCounts' | 'skillSessionCounts' | 'skillInvocationLastSeen' | 'skillToolCallCounts'
>;

export function timestampedOccurrences(item: ObservationInboxItem): number {
  return item.timestampedOccurrences
    ?? (item.firstSeen === '1970-01-01T00:00:00.000Z' ? 0 : item.occurrences);
}

const REVIEW_LABEL: Record<SkillReviewTone, { zh: string; en: string }> = {
  error: { zh: '高风险', en: 'High risk' },
  warning: { zh: '低风险', en: 'Low risk' },
  neutral: { zh: '无异常', en: 'No issues' },
  success: { zh: '无异常', en: 'No issues' },
};

export function skillReviewLabel(tone: SkillReviewTone, lang: 'zh' | 'en' = 'zh'): string {
  return REVIEW_LABEL[tone][lang];
}

export function buildObservationSkillRollups(model: SkillRollupModel): ObservationSkillRollup[] {
  const {
    allItems,
    skillInvocationCounts,
    skillSessionCounts,
    skillInvocationLastSeen,
    skillToolCallCounts,
  } = model;
  const itemsBySkill = allItems.reduce((map, item) => {
    const existing = map.get(item.skillName) ?? [];
    existing.push(item);
    map.set(item.skillName, existing);
    return map;
  }, new Map<string, ObservationInboxItem[]>());
  const allSkillNames = Array.from(new Set([
    ...Object.keys(skillInvocationCounts),
    ...Array.from(itemsBySkill.keys()),
  ]));
  return allSkillNames.map((skillName) => {
    const groupItems = itemsBySkill.get(skillName) ?? [];
    const counts: SkillRollupSeverityCounts = {
      high: groupItems.filter((item) => item.severity === 'high').length,
      medium: groupItems.filter((item) => item.severity === 'medium').length,
      low: groupItems.filter((item) => item.severity === 'low').length,
      noise: groupItems.filter((item) => item.severity === 'noise').length,
    };
    const invocationCount = ownRecordValue(skillInvocationCounts, skillName)
      ?? groupItems.reduce((sum, item) => sum + item.occurrences, 0);
    const sessionCount = ownRecordValue(skillSessionCounts, skillName)
      ?? new Set(groupItems.flatMap((item) => item.recentSessionIds)).size;
    const lastProblemSeen = groupItems
      .filter((item) => timestampedOccurrences(item) > 0)
      .reduce((value, item) => item.lastSeen > value ? item.lastSeen : value, '');
    const lastUsed = ownRecordValue(skillInvocationLastSeen, skillName) || lastProblemSeen || '';
    const sources = Array.from(new Set(groupItems.map((item) => item.sourceKind))).sort();
    const observationCount = groupItems.length;
    const toolCounts = ownRecordValue(skillToolCallCounts, skillName) ?? {};
    const metricCounts: SkillRollupMetricCounts = {
      bash: toolCounts.Bash ?? 0,
      read: toolCounts.Read ?? 0,
      grep: toolCounts.Grep ?? 0,
      uncertainty: groupItems.filter((item) => item.signalType === 'hedging').reduce((sum, item) => sum + item.occurrences, 0),
      explicitMarker: groupItems.filter((item) => item.signalType === 'explicit_marker').reduce((sum, item) => sum + item.occurrences, 0),
      bashProbe: groupItems.filter((item) => item.signalSubtype === 'bash_probe').reduce((sum, item) => sum + item.occurrences, 0),
      notFound: groupItems.filter((item) => item.signalSubtype === 'not_found').reduce((sum, item) => sum + item.occurrences, 0),
      toolLimit: groupItems.filter((item) => item.signalSubtype === 'tool_limit').reduce((sum, item) => sum + item.occurrences, 0),
      toolFailure: groupItems.filter((item) => item.signalSubtype === 'tool_failure').reduce((sum, item) => sum + item.occurrences, 0),
    };
    const reviewTone: SkillReviewTone = counts.high > 0
      ? 'error'
      : counts.medium > 0
        ? 'warning'
        : counts.noise > 0
          ? 'neutral'
          : 'success';
    return {
      skillName,
      invocationCount,
      sessionCount,
      observationCount,
      counts,
      lastProblemSeen,
      lastUsed,
      sources,
      metricCounts,
      reviewLabel: skillReviewLabel(reviewTone, 'zh'),
      reviewTone,
    };
  }).sort((a, b) => {
    const aRisk = a.counts.high * 100 + a.counts.medium * 10 + a.counts.noise;
    const bRisk = b.counts.high * 100 + b.counts.medium * 10 + b.counts.noise;
    if (bRisk !== aRisk) return bRisk - aRisk;
    return b.invocationCount - a.invocationCount;
  });
}
