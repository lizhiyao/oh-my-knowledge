import {
  loadLatestObservationInboxReports,
  queryObservationInbox,
  type ObservationInboxItem,
  type ObservationInboxReport,
} from './inbox.js';

export interface ObservationInboxViewModel {
  allItems: ObservationInboxItem[];
  items: ObservationInboxItem[];
  reports: ObservationInboxReport[];
  skillInvocationCounts: Record<string, number>;
  skillSessionCounts: Record<string, number>;
  skillInvocationLastSeen: Record<string, string>;
  skillToolCallCounts: Record<string, Record<string, number>>;
  totalSkillInvocations: number;
  severitySkillCounts: Record<ObservationInboxItem['severity'], number>;
  skillCount: number;
  reportCount: number;
  latestSeenLabel: string;
}

export function buildObservationInboxViewModel(observationsDir: string): ObservationInboxViewModel {
  const allItems = queryObservationInbox(observationsDir);
  const items = allItems.slice(0, 100);
  const reports = loadLatestObservationInboxReports(observationsDir);
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
  const latestSeen = allItems.reduce((latest, item) => item.lastSeen > latest ? item.lastSeen : latest, '');
  const reportCount = reports.length;
  const latestSeenLabel = latestSeen ? latestSeen.slice(0, 19).replace('T', ' ') : '—';

  return {
    allItems,
    items,
    reports,
    skillInvocationCounts,
    skillSessionCounts,
    skillInvocationLastSeen,
    skillToolCallCounts,
    totalSkillInvocations,
    severitySkillCounts,
    skillCount,
    reportCount,
    latestSeenLabel,
  };
}
