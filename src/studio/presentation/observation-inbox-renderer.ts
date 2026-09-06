import { DEFAULT_LANG } from './layout.js';
import type { Lang } from '../../shared/language.js';
import type {
  ObservationInboxItem,
  ObservationInboxViewModel,
} from '../../observability/inbox/view-model.js';
import { incrementRecordCount } from '../../shared/record-count.js';
import { createObservationExperienceWorkspace } from './observation-inbox/experience-workspace-renderer.js';
import { createObservationMetricRenderers } from './observation-inbox/metric-renderer.js';
import { renderObservationInboxDocument } from './observation-inbox/page-renderer.js';
import { createObservationProcessWorkspace } from './observation-inbox/process-workspace-renderer.js';
import { createObservationReviewRenderers } from './observation-inbox/review-renderer.js';
import { createObservationSignalRenderers } from './observation-inbox/signal-renderer.js';
import { createObservationSkillChainRenderers } from './observation-inbox/skill-chain-renderer.js';
import { createReviewerReportRenderers } from './observation-inbox/reviewer-report.js';
import { formatTimeRange as formatTimeRangeImpl } from './observation-inbox/helpers.js';
export { renderFeedbackAttributionLabel } from './observation-inbox/helpers.js';

type ExperienceSessionSummary = ObservationInboxViewModel['experienceReports'][number]['sessions'][number];

export function renderObservationInboxPage(model: ObservationInboxViewModel, lang: Lang = DEFAULT_LANG): string {
  const {
    effectiveExperienceReports: experienceReports,
    skillChains,
    skillDerivedStandards,
    reviewState,
  } = model;
  const experience = experienceReports.find((report) => report.skills.length > 0 || report.sessions.length > 0 || report.invocations.length > 0);
  const reviewerReportRenderers = createReviewerReportRenderers(skillDerivedStandards);
  const experienceToolCountsBySkill = new Map<string, Record<string, number>>();
  const experienceSkillOriginCountsBySkill = new Map<string, Record<string, number>>();
  const experienceAttributionCountsBySkill = new Map<string, Record<string, number>>();
  for (const invocation of experience?.invocations ?? []) {
    const toolCounts = experienceToolCountsBySkill.get(invocation.skillName) ?? {};
    for (const [tool, count] of Object.entries(invocation.toolCounts ?? {})) {
      incrementRecordCount(toolCounts, tool, count);
    }
    experienceToolCountsBySkill.set(invocation.skillName, toolCounts);

    const originLabel = invocation.attribution.pluginName
      ? `Skill 来源：插件 ${invocation.attribution.pluginName}`
      : 'Skill 来源：本地 skill';
    const originCounts = experienceSkillOriginCountsBySkill.get(invocation.skillName) ?? {};
    incrementRecordCount(originCounts, originLabel);
    experienceSkillOriginCountsBySkill.set(invocation.skillName, originCounts);

    const attributionMethod = invocation.attribution.source === 'command-name'
      ? '通过斜杠命令触发'
      : invocation.attribution.source === 'skill-tool'
        ? '通过 Skill 工具启动'
        : invocation.attribution.source === 'business-action' || invocation.attribution.source === ['ai', 'ma-cmd'].join('')
          ? '通过业务动作触发'
          : invocation.attribution.source === 'read-skill-md'
            ? '通过读取 Skill 文档推断'
            : invocation.attribution.source === 'general'
              ? '未识别到明确触发方式'
              : invocation.attribution.source || '未记录触发方式';
    const attributionTarget = invocation.attribution.commandName ?? invocation.attribution.rawSkillRef ?? invocation.skillName;
    const attributionLabel = attributionTarget ? `${attributionMethod}：${attributionTarget}` : attributionMethod;
    const attributionCounts = experienceAttributionCountsBySkill.get(invocation.skillName) ?? {};
    incrementRecordCount(attributionCounts, attributionLabel);
    experienceAttributionCountsBySkill.set(invocation.skillName, attributionCounts);
  }
  const sessionTimeLabel = lang === 'zh' ? 'Session 时间' : 'Session time';
  const sessionTimeRangeLabel = lang === 'zh' ? 'Session 时间范围' : 'Session time range';
  const latestInvocationLabel = lang === 'zh' ? '最近调用' : 'Latest invocation';
  const invocationWindowLabel = lang === 'zh' ? '调用窗口' : 'Invocation window';
  const formatTimeRange = (start?: string, end?: string, durationMs?: number): string => formatTimeRangeImpl(start, end, durationMs, lang);
  const timestampedOccurrences = (item: ObservationInboxItem): number =>
    item.timestampedOccurrences
      ?? (item.firstSeen === '1970-01-01T00:00:00.000Z' ? 0 : item.occurrences);
  const observedItemTimestamp = (item: ObservationInboxItem, value: string): string =>
    timestampedOccurrences(item) > 0
      ? value.slice(0, 19).replace('T', ' ')
      : (lang === 'zh' ? '未记录' : 'Not recorded');
  const sessionTimestampedInvocationCount = (session: ExperienceSessionSummary): number =>
    session.timestampedInvocationCount
      ?? (session.startTimestamp === '1970-01-01T00:00:00.000Z' ? 0 : session.invocationIds.length);
  const observedSessionRange = (session: ExperienceSessionSummary): string => {
    const count = sessionTimestampedInvocationCount(session);
    if (count === 0) return lang === 'zh' ? '未记录' : 'Not recorded';
    const range = formatTimeRange(session.startTimestamp, session.endTimestamp);
    return count < session.invocationIds.length
      ? `${range}${lang === 'zh' ? '（部分调用无时间）' : ' (partial timestamps)'}`
      : range;
  };
  const observedSessionTimestamp = (session: ExperienceSessionSummary, value: string): string =>
    sessionTimestampedInvocationCount(session) > 0
      ? value.slice(0, 19).replace('T', ' ')
      : (lang === 'zh' ? '未记录' : 'Not recorded');
  const skillTimestampedInvocationCount = (skill: NonNullable<typeof experience>['skills'][number]): number =>
    skill.timestampedInvocationCount
      ?? (skill.firstSeen === '1970-01-01T00:00:00.000Z' ? 0 : skill.invocationCount);
  const observationMetricRenderers = createObservationMetricRenderers({ experience, reviewState, unappliedMetricAnnotations: model.unappliedMetricAnnotations });
  const observationSignalRenderers = createObservationSignalRenderers(lang);
  const observationSkillChainRenderers = createObservationSkillChainRenderers({
    experienceToolCountsBySkill,
    skillChains,
    skillDerivedStandards,
    metricRenderers: observationMetricRenderers,
  });
  const observationReviewRenderers = createObservationReviewRenderers({
    experience,
    lang,
    observedItemTimestamp,
    reviewState,
    timestampedOccurrences,
    metricRenderers: observationMetricRenderers,
    signalRenderers: observationSignalRenderers,
    skillChainRenderers: observationSkillChainRenderers,
  });
  const observationProcessWorkspace = createObservationProcessWorkspace({
    model,
    experience,
    lang,
    metricRenderers: observationMetricRenderers,
    reviewRenderers: observationReviewRenderers,
    signalRenderers: observationSignalRenderers,
    timestampedOccurrences,
  });
  const observationExperienceWorkspace = createObservationExperienceWorkspace({
    model,
    experience,
    lang,
    experienceAttributionCountsBySkill,
    experienceSkillOriginCountsBySkill,
    formatTimeRange,
    invocationWindowLabel,
    latestInvocationLabel,
    observedSessionRange,
    observedSessionTimestamp,
    processWorkspace: observationProcessWorkspace,
    metricRenderers: observationMetricRenderers,
    reviewRenderers: observationReviewRenderers,
    reviewerReportRenderers,
    sessionTimeLabel,
    sessionTimeRangeLabel,
    sessionTimestampedInvocationCount,
    skillChainRenderers: observationSkillChainRenderers,
    skillTimestampedInvocationCount,
  });
  return renderObservationInboxDocument({
    model,
    lang,
    experienceWorkspace: observationExperienceWorkspace,
    processWorkspace: observationProcessWorkspace,
    reviewRenderers: observationReviewRenderers,
  });
}
