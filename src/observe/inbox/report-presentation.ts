/**
 * 观察收件箱报告的呈现：按技能汇总与 CLI 展示文本，只消费构建层与存取层的结果。
 */
import type {
  ObservationInboxItem,
  ObservationInboxReport,
  ObservationMessageRef,
  ObservationSkillRollup,
} from '../contracts/inbox.js';
import {
  incrementRecordCount,
  sumRecordCounts,
} from '../../shared/record-count.js';

import {
  buildObservationMessageWindow,
} from './report-building.js';
import {
  timestampedOccurrencesOf,
} from './report-primitives.js';

export function summarizeObservationInboxBySkill(
  items: ObservationInboxItem[],
  reports: ObservationInboxReport[] = [],
): ObservationSkillRollup[] {
  const invocationCounts = reports.reduce((acc, report) => {
    for (const [skill, count] of Object.entries(report.meta.skillInvocationCounts ?? {})) {
      incrementRecordCount(acc, skill, count);
    }
    return acc;
  }, {} as Record<string, number>);
  const sessionCounts = reports.reduce((acc, report) => {
    for (const [skill, count] of Object.entries(report.meta.skillSessionCounts ?? {})) {
      incrementRecordCount(acc, skill, count);
    }
    return acc;
  }, {} as Record<string, number>);
  const bySkill = new Map<string, ObservationInboxItem[]>();
  for (const item of items) {
    const group = bySkill.get(item.skillName) ?? [];
    group.push(item);
    bySkill.set(item.skillName, group);
  }
  const skillNames = new Set([...Object.keys(invocationCounts), ...bySkill.keys()]);
  return Array.from(skillNames).map((skillName) => {
    const group = bySkill.get(skillName) ?? [];
    return {
      skillName,
      invocationCount: invocationCounts[skillName]
        ?? sumRecordCounts(...group.map((item) => item.occurrences)),
      sessionCount: sessionCounts[skillName] ?? new Set(group.flatMap((item) => item.recentSessionIds)).size,
      observationCount: group.length,
      highCount: group.filter((item) => item.severity === 'high').length,
      mediumCount: group.filter((item) => item.severity === 'medium').length,
      lowCount: group.filter((item) => item.severity === 'low').length,
      noiseCount: group.filter((item) => item.severity === 'noise').length,
      latestSeen: group
        .filter((item) => timestampedOccurrencesOf(item) > 0)
        .reduce((latest, item) => item.lastSeen > latest ? item.lastSeen : latest, ''),
    };
  }).sort((a, b) => {
    const riskA = a.highCount * 100 + a.mediumCount * 10 + a.lowCount;
    const riskB = b.highCount * 100 + b.mediumCount * 10 + b.lowCount;
    if (riskB !== riskA) return riskB - riskA;
    return b.invocationCount - a.invocationCount;
  });
}

export function formatObservationShow(item: ObservationInboxItem): string {
  const window = item.messageWindow ?? buildObservationMessageWindow(item);
  const lines = [
    `Observation ${item.id}`,
    `skill=${item.skillName} severity=${item.severity} signal=${item.signalType}/${item.signalSubtype} confidence=${item.confidence.toFixed(2)} attribution=${item.attributionConfidence.toFixed(2)}`,
    `source=${item.sourceTrace}`,
    item.severityReasonCode ? `reason=${item.severityReasonCode}` : '',
    '',
  ].filter(Boolean);
  if (item.captureCoverage) {
    lines.push(
      `coverage=${item.captureCoverage.coverageStatus} capture=${item.captureCoverage.capturePath}`,
      `observed=${item.captureCoverage.observedEventKinds.join(',')}`,
      `unavailable=${item.captureCoverage.unavailableEventKinds.join(',')}`,
    );
  }
  if (item.evidence.userFeedbackSnippet) {
    lines.push(`userFeedback=${item.evidence.userFeedbackSnippet}`);
  }
  if (item.evidence.submittedEvidenceSnippet) {
    lines.push(`submittedEvidence=${item.evidence.submittedEvidenceSnippet}`);
  }
  if (!window) {
    lines.push('No message window available for this observation.');
    return lines.join('\n');
  }
  lines.push('--- 上文 ---');
  lines.push(...formatMessageRefs(window.before));
  lines.push('--- 失败点 / 触发点 ---');
  lines.push(...formatMessageRefs(window.event));
  lines.push('--- 下文 ---');
  lines.push(...formatMessageRefs(window.after));
  lines.push(`resolutionAfter=${window.resolutionAfter}`);
  return lines.join('\n');
}

function formatMessageRefs(messages: ObservationMessageRef[]): string[] {
  if (messages.length === 0) return ['(none)'];
  return messages.map((message) => `[${message.messageIndex}] ${message.role}${message.timestamp ? ` ${message.timestamp}` : ''}${message.uuid ? ` ${message.uuid}` : ''}\n${message.snippet}`);
}
