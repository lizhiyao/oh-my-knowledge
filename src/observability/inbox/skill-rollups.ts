import { ownRecordValue } from '../../shared/record-count.js';
import type { TraceSourceKind } from '../contracts/trace.js';
import type { ObservationInboxItem } from '../contracts/inbox.js';
import type { ObservationInboxViewModel } from './view-model.js';
import { signalEvidenceConclusion } from './signal-semantics.js';

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

/** Reviewer 待办建议项（由看板聚合派生，#839 批次 5）。 */
export interface ReviewActionItem {
  readonly skillName: string;
  readonly priority: 'P0' | 'P1' | 'P2' | 'P3';
  readonly tone: SkillReviewTone;
  readonly action: string;
  readonly reason: string;
  readonly evidenceCount: number;
  readonly sample: string;
}

const ACTION_PRIORITY_RANK: Record<string, number> = { P0: 4, P1: 3, P2: 2, P3: 1 };

interface ActionText {
  readonly action: { readonly zh: string; readonly en: string };
  readonly reason: { readonly zh: string; readonly en: string };
}

const ACTION_TEXT: Record<'high' | 'repeated' | 'low' | 'noise' | 'empty', ActionText> = {
  high: {
    action: { zh: '先看这个 skill 是否漏写了关键信息', en: 'Check whether this skill is missing key information' },
    reason: {
      zh: '有高风险记录：agent 查找失败后，没有看到它在同一轮里找到替代结果，或回答里明确暴露了缺口。',
      en: 'High-risk findings: the agent failed to find something and no same-turn alternative appeared, or the answer exposed a gap.',
    },
  },
  repeated: {
    action: { zh: '看是否要补一段“推荐查找路径”', en: 'Consider adding a recommended lookup path' },
    reason: {
      zh: 'agent 在这个 skill 运行时反复试目录或路径，共 {count} 次。单次不用改，但反复出现可能说明 skill 没告诉它该优先看哪里。',
      en: 'The agent repeatedly probed directories or paths in this skill ({count} times). Once is fine, but repetition suggests the skill does not say where to look first.',
    },
  },
  low: {
    action: { zh: '抽几条看看是否真的影响使用', en: 'Sample a few entries to see whether they affect usage' },
    reason: {
      zh: '当前主要是低风险记录：可能只是 agent 正常探索路径，或回答里出现了不确定表达。先看样例，不要直接改 skill。',
      en: 'Mostly low-risk findings: possibly normal path exploration or hedging. Sample first; do not change the skill directly.',
    },
  },
  noise: {
    action: { zh: '暂时不用改 skill', en: 'No skill change needed for now' },
    reason: {
      zh: '当前只有文件不存在、权限、文件过大或工具执行失败这类记录。它们更像运行环境或工具限制，默认不作为 skill 修改依据。',
      en: 'Only missing files, permissions, oversized files, or tool failures. These look like environment or tool limits, not skill content issues.',
    },
  },
  empty: {
    action: { zh: '打开明细看 1-2 条证据', en: 'Open the details and check 1-2 evidence entries' },
    reason: {
      zh: '这类记录说明运行中出现过异常信号，但现在还不能直接判断 skill 需要修改。',
      en: 'These records show abnormal signals during runs, but they do not yet prove the skill needs a change.',
    },
  },
};

/**
 * 从看板聚合派生 Reviewer 待办建议（与历史 HTML 版优先级判定一致）：
 * 高风险 → P0；低风险累计 3 次以上 → P1；有低/不确定 → P2；仅噪声 → P3。
 */
export function buildReviewActionItems(
  model: SkillRollupModel,
  lang: 'zh' | 'en' = 'zh',
): ReviewActionItem[] {
  const rollups = buildObservationSkillRollups(model);
  const itemsBySkill = model.allItems.reduce((map, item) => {
    const existing = map.get(item.skillName) ?? [];
    existing.push(item);
    map.set(item.skillName, existing);
    return map;
  }, new Map<string, ObservationInboxItem[]>());
  return rollups
    .filter((row) => row.observationCount > 0)
    .map((row) => {
      const groupItems = itemsBySkill.get(row.skillName) ?? [];
      const repeatedMedium = groupItems
        .filter((item) => item.severity === 'medium')
        .reduce((sum, item) => sum + item.occurrences, 0);
      const noiseCount = groupItems
        .filter((item) => item.severity === 'noise')
        .reduce((sum, item) => sum + item.occurrences, 0);
      let priority: ReviewActionItem['priority'] = 'P2';
      let tone: SkillReviewTone = 'neutral';
      let text = ACTION_TEXT.empty;
      if (row.counts.high > 0) {
        priority = 'P0';
        tone = 'error';
        text = ACTION_TEXT.high;
      } else if (repeatedMedium >= 3) {
        priority = 'P1';
        tone = 'warning';
        text = ACTION_TEXT.repeated;
      } else if (row.counts.medium > 0 || row.counts.low > 0) {
        priority = 'P2';
        tone = 'warning';
        text = ACTION_TEXT.low;
      } else if (noiseCount > 0) {
        priority = 'P3';
        tone = 'neutral';
        text = ACTION_TEXT.noise;
      }
      const topItem = groupItems[0];
      return {
        skillName: row.skillName,
        priority,
        tone,
        action: text.action[lang],
        reason: text.reason[lang].replace('{count}', String(repeatedMedium)),
        evidenceCount: groupItems.reduce((sum, item) => sum + item.occurrences, 0),
        sample: topItem ? signalEvidenceConclusion(topItem, lang) : '',
      };
    })
    .sort((a, b) => {
      const byPriority = (ACTION_PRIORITY_RANK[b.priority] ?? 0) - (ACTION_PRIORITY_RANK[a.priority] ?? 0);
      if (byPriority !== 0) return byPriority;
      return b.evidenceCount - a.evidenceCount;
    });
}
