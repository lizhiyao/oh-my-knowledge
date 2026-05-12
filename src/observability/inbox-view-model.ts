import {
  loadLatestObservationInboxReports,
  queryObservationInbox,
  type ObservationInboxItem,
  type ObservationInboxReport,
} from './inbox.js';
import type { ObservationExperienceReport } from './experience.js';
import { loadObservationReviewState, type ObservationReviewState } from './review-state.js';
import { buildObservationSkillChains, type ObservationSkillChain } from './skill-chain.js';

export interface ObservationInboxViewModel {
  activeSkill?: string;
  allItems: ObservationInboxItem[];
  items: ObservationInboxItem[];
  reports: ObservationInboxReport[];
  experienceReports: ObservationExperienceReport[];
  skillInvocationCounts: Record<string, number>;
  skillSessionCounts: Record<string, number>;
  skillInvocationLastSeen: Record<string, string>;
  skillToolCallCounts: Record<string, Record<string, number>>;
  skillChains: Record<string, ObservationSkillChain>;
  totalSkillInvocations: number;
  severitySkillCounts: Record<ObservationInboxItem['severity'], number>;
  skillCount: number;
  reportCount: number;
  latestSeenLabel: string;
  reviewState: ObservationReviewState;
}

export interface ObservationInboxViewModelOptions {
  skill?: string;
}

export function buildObservationInboxViewModel(observationsDir: string, options: ObservationInboxViewModelOptions = {}): ObservationInboxViewModel {
  const activeSkill = options.skill?.trim() || undefined;
  const allItems = filterItemsBySkill(queryObservationInbox(observationsDir), activeSkill);
  const items = allItems.slice(0, 100);
  const reports = loadLatestObservationInboxReports(observationsDir).map((report) => filterReportBySkill(report, activeSkill));
  const experienceReports = reports.flatMap((report) => report.experience ? [report.experience] : []);
  const skillInvocationCounts = reports.reduce((acc, report) => {
    for (const [skill, count] of Object.entries(report.meta.skillInvocationCounts ?? {})) {
      acc[skill] = (acc[skill] ?? 0) + count;
    }
    return acc;
  }, {} as Record<string, number>);
  const skillSessionCounts = reports.reduce((acc, report) => {
    for (const [skill, count] of Object.entries(report.meta.skillSessionCounts ?? {})) {
      acc[skill] = (acc[skill] ?? 0) + count;
    }
    return acc;
  }, {} as Record<string, number>);
  const skillInvocationLastSeen = reports.reduce((acc, report) => {
    for (const [skill, timestamp] of Object.entries(report.meta.skillInvocationLastSeen ?? {})) {
      if (!acc[skill] || timestamp > acc[skill]) acc[skill] = timestamp;
    }
    return acc;
  }, {} as Record<string, string>);
  const skillToolCallCounts = reports.reduce((acc, report) => {
    for (const [skill, counts] of Object.entries(report.meta.skillToolCallCounts ?? {})) {
      const target = acc[skill] ?? {};
      for (const [tool, count] of Object.entries(counts)) {
        target[tool] = (target[tool] ?? 0) + count;
      }
      acc[skill] = target;
    }
    return acc;
  }, {} as Record<string, Record<string, number>>);
  const totalSkillInvocations = Object.values(skillInvocationCounts).reduce((sum, count) => sum + count, 0);
  const countSkillsBySeverity = (...severities: ObservationInboxItem['severity'][]): number =>
    new Set(allItems.filter((item) => severities.includes(item.severity)).map((item) => item.skillName)).size;
  const severitySkillCounts = {
    high: countSkillsBySeverity('high'),
    medium: countSkillsBySeverity('medium'),
    low: countSkillsBySeverity('low'),
    noise: countSkillsBySeverity('noise'),
  };
  const skillCount = new Set([...Object.keys(skillInvocationCounts), ...allItems.map((item) => item.skillName)]).size;
  const skillNames = Array.from(new Set([
    ...Object.keys(skillInvocationCounts),
    ...allItems.map((item) => item.skillName),
    ...experienceReports.flatMap((report) => report.skills.map((skill) => skill.skillName)),
  ]));
  const skillChains = buildObservationSkillChains(skillNames, process.cwd(), experienceReports);
  const latestSeen = allItems.reduce((latest, item) => item.lastSeen > latest ? item.lastSeen : latest, '');
  const reportCount = reports.length;
  const latestSeenLabel = latestSeen ? latestSeen.slice(0, 19).replace('T', ' ') : '—';
  const reviewState = loadObservationReviewState(observationsDir);

  return {
    activeSkill,
    allItems,
    items,
    reports,
    experienceReports,
    skillInvocationCounts,
    skillSessionCounts,
    skillInvocationLastSeen,
    skillToolCallCounts,
    skillChains,
    totalSkillInvocations,
    severitySkillCounts,
    skillCount,
    reportCount,
    latestSeenLabel,
    reviewState,
  };
}

function filterItemsBySkill(items: ObservationInboxItem[], skillName?: string): ObservationInboxItem[] {
  return skillName ? items.filter((item) => item.skillName === skillName) : items;
}

function pickRecordValue<T>(value: Record<string, T> | undefined, key: string): Record<string, T> | undefined {
  if (!value || value[key] == null) return undefined;
  return { [key]: value[key] };
}

function filterReportBySkill(report: ObservationInboxReport, skillName?: string): ObservationInboxReport {
  if (!skillName) return report;
  const items = report.items.filter((item) => item.skillName === skillName);
  const experience = report.experience ? {
    ...report.experience,
    meta: {
      ...report.experience.meta,
      sessionCount: report.experience.sessions.filter((session) => session.skillName === skillName).length,
      skillCount: report.experience.skills.some((skill) => skill.skillName === skillName) ? 1 : 0,
      invocationCount: report.experience.invocations.filter((invocation) => invocation.skillName === skillName).length,
      goalSliceCount: report.experience.goalSlices.filter((goal) => goal.skillName === skillName).length,
    },
    goalSlices: report.experience.goalSlices.filter((goal) => goal.skillName === skillName),
    invocations: report.experience.invocations.filter((invocation) => invocation.skillName === skillName),
    sessions: report.experience.sessions.filter((session) => session.skillName === skillName),
    skills: report.experience.skills.filter((skill) => skill.skillName === skillName),
  } : undefined;
  return {
    ...report,
    meta: {
      ...report.meta,
      itemCount: items.length,
      skillInvocationCounts: pickRecordValue(report.meta.skillInvocationCounts, skillName),
      skillSessionCounts: pickRecordValue(report.meta.skillSessionCounts, skillName),
      skillInvocationLastSeen: pickRecordValue(report.meta.skillInvocationLastSeen, skillName),
      skillToolCallCounts: pickRecordValue(report.meta.skillToolCallCounts, skillName),
    },
    items,
    experience,
  };
}
