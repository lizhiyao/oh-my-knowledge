import { ownRecordValue } from '../../shared/record-count.js';
import type { ObservationInboxReport } from '../contracts/inbox.js';

function pickSkillValue<T>(value: Record<string, T> | undefined, skillName: string): Record<string, T> | undefined {
  const selected = value ? ownRecordValue(value, skillName) : undefined;
  return selected == null ? undefined : { [skillName]: selected };
}

export function filterInboxReportsBySkill(reports: ObservationInboxReport[], skill?: string): ObservationInboxReport[] {
  if (!skill) return reports;
  return reports.map((report) => ({
    ...report,
    meta: {
      ...report.meta,
      skillInvocationCounts: pickSkillValue(report.meta.skillInvocationCounts, skill),
      skillSessionCounts: pickSkillValue(report.meta.skillSessionCounts, skill),
      skillInvocationLastSeen: pickSkillValue(report.meta.skillInvocationLastSeen, skill),
      skillToolCallCounts: pickSkillValue(report.meta.skillToolCallCounts, skill),
    },
  }));
}
