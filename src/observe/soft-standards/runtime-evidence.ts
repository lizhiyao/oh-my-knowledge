import type { ObservationInboxViewModel } from '../inbox/view-model.js';
import type { ExperienceTimelineEvent } from '../experience.js';
import type { SkillLlmEnhancedRuntimeEvidence } from './types.js';

export function hasLlmEnhancedRuntimeEvidence(evidence: SkillLlmEnhancedRuntimeEvidence): boolean {
  return evidence.userMessages.length > 0
    || evidence.goalSlices.some((goal) => Boolean(goal.inferredUserGoal || goal.userMessages?.length))
    || evidence.assistantMessages.length > 0
    || evidence.artifactCandidates.length > 0
    || evidence.toolCalls.length > 0
    || evidence.findings.length > 0
    || Boolean(evidence.skillRuntimeEvidencePack?.nodeEvidence.length);
}

function cleanEvidenceText(value?: string): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 800);
}

function eventText(event?: ExperienceTimelineEvent): string {
  return cleanEvidenceText(event?.snippet ?? event?.fullText);
}

export function buildLlmEnhancedRuntimeEvidence(
  view: ObservationInboxViewModel,
  skillName: string,
): SkillLlmEnhancedRuntimeEvidence {
  const reports = view.experienceReports;
  const sessions = reports.flatMap((report) => report.sessions.filter((session) => session.skillName === skillName));
  const invocations = reports.flatMap((report) => report.invocations.filter((invocation) => invocation.skillName === skillName));
  const goalSlices = reports.flatMap((report) => report.goalSlices.filter((goal) => goal.skillName === skillName));
  const timeline = invocations.flatMap((invocation) => invocation.timeline ?? []);
  const userMessages = Array.from(new Set([
    ...goalSlices.flatMap((goal) => goal.userMessageRefs.map((ref) => cleanEvidenceText(ref.snippet))),
    ...sessions.map((session) => cleanEvidenceText(session.evidenceChain.firstUserMessage?.snippet)),
    ...timeline.filter((event) => event.kind === 'user_message').map(eventText),
  ].filter(Boolean))).slice(0, 12);
  const assistantMessages = Array.from(new Set([
    ...sessions.map((session) => cleanEvidenceText(session.evidenceChain.lastAssistantMessage?.snippet)),
    ...timeline.filter((event) => event.kind === 'assistant_message').map(eventText),
  ].filter(Boolean))).slice(0, 12);
  const artifactCandidates = Array.from(new Set(timeline
    .filter((event) => event.kind === 'assistant_message' && /(?:outputs\/runs|\.md\b|\.html\b|https?:\/\/|产物|文档|报告|方案路径|结果文件)/i.test(eventText(event)))
    .map(eventText)
    .filter(Boolean))).slice(0, 8);
  const toolCalls = Array.from(new Set(timeline
    .filter((event) => event.kind === 'tool_use')
    .map((event) => cleanEvidenceText(`${event.toolName ?? 'tool'} ${event.snippet ?? event.fullText ?? ''}`))
    .filter(Boolean))).slice(0, 12);
  const findings = Array.from(new Set(sessions.flatMap((session) => [
    ...(session.reviewerReport?.findings ?? []).map((finding) => cleanEvidenceText(`${finding.title}: ${finding.body}`)),
    ...(session.ruleFindings ?? []).map((finding) => finding.code),
  ]).filter(Boolean))).slice(0, 12);
  return {
    goalSlices: goalSlices.slice(0, 8).map((goal) => ({
      id: goal.id,
      sessionId: goal.sessionId,
      inferredUserGoal: cleanEvidenceText(goal.inferredUserGoal),
      userMessages: goal.userMessageRefs.map((ref) => cleanEvidenceText(ref.snippet)).filter(Boolean).slice(0, 5),
    })),
    userMessages,
    assistantMessages,
    artifactCandidates,
    toolCalls,
    findings,
    skillRuntimeEvidencePack: view.skillChains[skillName]?.runtime.evidencePack,
  };
}

