/**
 * 会话故事的技能段与角色：从技能链接推断段窗口、技能类型与 episode 角色。
 */
import type {
  ExperienceEpisodeRole,
  ExperienceInvocation,
  ExperienceMessageRange,
  ExperienceRuntimeSkillType,
  ExperienceSessionStorySkillLink,
  ExperienceSessionStorySkillRole,
  ExperienceSessionSummary,
  ExperienceSkillSegment,
  ExperienceTimelineEvent,
} from '../contracts/experience.js';
import {
  loadFrontmatterSkillType,
} from '../skill-health/experience-frontmatter.js';
import {
  hashParts,
  isObjectRecord,
  maxDefined,
  maxString,
  minDefined,
  minString,
} from './primitives.js';
import {
  uniqueEvidenceRefs,
} from './report-derivations.js';
import {
  isOrchestrationRuntimeEvent,
} from './session-story-evidence.js';

export function sessionStorySkillSegments(
  session: ExperienceSessionSummary,
  invocations: ExperienceInvocation[],
  skillLinks: ExperienceSessionStorySkillLink[],
): ExperienceSkillSegment[] {
  const invocationById = new Map(invocations.map((invocation) => [invocation.id, invocation]));
  return skillLinks.map((link, index) => {
    const group = link.invocationIds.map((id) => invocationById.get(id)).filter((value): value is ExperienceInvocation => Boolean(value));
    const declaredSkillType = loadFrontmatterSkillType(link.skillName, session.cwd);
    const traceInferredSkillType = traceInferredSkillTypeForLink(link);
    const skillType = declaredSkillType ?? traceInferredSkillType ?? 'unknown';
    const evidenceRefs = uniqueEvidenceRefs([
      ...link.evidenceRefs,
      ...group.flatMap((invocation) => invocation.evidenceRefs.slice(0, 2)),
    ]).slice(0, 6);
    const messageRanges: ExperienceMessageRange[] = group
      .map((invocation): ExperienceMessageRange | undefined => {
        const timelineWithIndex = invocation.timeline.filter((event) => typeof event.messageIndex === 'number');
        const indexes = timelineWithIndex
          .map((event) => event.messageIndex)
          .filter((value): value is number => typeof value === 'number');
        const startMessageIndex = minDefined(indexes);
        const endMessageIndex = maxDefined(indexes);
        const traceId = invocation.traceId ?? timelineWithIndex[0]?.traceId;
        const sourceTrace = invocation.sourceTrace ?? timelineWithIndex[0]?.sourceTrace;
        const sessionId = invocation.sessionId ?? timelineWithIndex[0]?.sessionId;
        return typeof startMessageIndex === 'number' && typeof endMessageIndex === 'number'
          ? { startMessageIndex, endMessageIndex, traceId, sourceTrace, sessionId }
          : undefined;
      })
      .filter((value): value is ExperienceMessageRange => Boolean(value));
    const messageIndexes = messageRanges.flatMap((range) => [range.startMessageIndex, range.endMessageIndex]);
    return {
      id: hashParts('session-story-skill-segment', session.id, link.skillName, String(index)),
      order: index + 1,
      skillName: link.skillName,
      skillType,
      skillTypeSource: declaredSkillType ? 'frontmatter' : traceInferredSkillType ? 'trace' : 'unknown',
      declaredSkillType,
      traceInferredSkillType,
      episodeRole: episodeRoleForLink(link, session, skillType),
      skillInvocationIds: link.invocationIds,
      startMessageIndex: minDefined(messageIndexes),
      endMessageIndex: maxDefined(messageIndexes),
      messageRanges,
      startTimestamp: minString(group.map((invocation) => invocation.startTimestamp)) ?? session.startTimestamp,
      endTimestamp: maxString(group.map((invocation) => invocation.endTimestamp)) ?? session.endTimestamp,
      typeSpecificChecklist: [],
      evidenceRefs,
    };
  });
}

function traceInferredSkillTypeForLink(link: ExperienceSessionStorySkillLink): ExperienceRuntimeSkillType | undefined {
  if (link.role === 'router') return 'router';
  if (link.role === 'executor' || link.role === 'mixed') return 'executor';
  return undefined;
}

function episodeRoleForLink(
  link: ExperienceSessionStorySkillLink,
  session: ExperienceSessionSummary,
  resolvedSkillType?: ExperienceRuntimeSkillType,
): ExperienceEpisodeRole {
  const skillType = resolvedSkillType ?? loadFrontmatterSkillType(link.skillName, session.cwd) ?? traceInferredSkillTypeForLink(link) ?? 'unknown';
  if (skillType === 'router') return 'router';
  if (skillType === 'delegation') return 'delegator';
  if (skillType === 'executor') return 'main_executor';
  if (skillType === 'advisory') return 'observer';
  if (skillType === 'workflow_owner') return 'router';
  if (link.role === 'router') return 'router';
  if (link.role === 'executor' || link.role === 'mixed') return 'main_executor';
  return 'supporting';
}

export function inferSkillRole(group: ExperienceInvocation[], allInvocations: ExperienceInvocation[], session: ExperienceSessionSummary): ExperienceSessionStorySkillRole {
  const hasRoutingSignal = group.some((invocation) => routingEvidenceEvents(invocation).length > 0);
  const hasBranchDispatch = (session.timelineTree?.branches.length ?? 0) > 0 && group.some((invocation) =>
    invocation.timeline.some((event) =>
      isOrchestrationRuntimeEvent(event)
      || isDifferentSkillInvocationEvent(event, invocation.skillName)
    )
  );
  const hasExecutionSignal = group.some((invocation) =>
    invocation.timeline.some((event) =>
      event.kind === 'tool_use'
      && !isOrchestrationRuntimeEvent(event)
      && !isDifferentSkillInvocationEvent(event, invocation.skillName)
    )
  );
  if ((hasRoutingSignal || hasBranchDispatch) && allInvocations.length > group.length) return hasExecutionSignal ? 'mixed' : 'router';
  if (hasRoutingSignal || hasBranchDispatch) return 'router';
  if (hasExecutionSignal) return 'executor';
  return 'unknown';
}

export function routingEvidenceEvents(invocation: ExperienceInvocation): ExperienceTimelineEvent[] {
  return invocation.timeline
    .filter((event) =>
      isOrchestrationRuntimeEvent(event)
      || isDifferentSkillInvocationEvent(event, invocation.skillName)
    )
    .slice(0, 3);
}

function isDifferentSkillInvocationEvent(
  event: ExperienceTimelineEvent,
  currentSkillName: string,
): boolean {
  if (event.kind !== 'tool_use' || !/^Skill$/i.test(event.toolName ?? '')) return false;
  const text = event.fullText ?? event.snippet ?? '';
  let targetSkill: string | undefined;
  try {
    const input: unknown = JSON.parse(text);
    if (isObjectRecord(input)) {
      targetSkill = typeof input.skill === 'string'
        ? input.skill
        : typeof input.name === 'string'
          ? input.name
          : undefined;
    }
  } catch {
    targetSkill = text.match(
      /["']?(?:skill|name)["']?\s*[:=]\s*["']?([a-z0-9][\w.-]*)/i,
    )?.[1];
  }
  return Boolean(
    targetSkill
    && targetSkill.trim().toLowerCase() !== currentSkillName.trim().toLowerCase(),
  );
}

export function skillRoleLabel(role: ExperienceSessionStorySkillRole): string {
  if (role === 'router') return '路由';
  if (role === 'executor') return '执行';
  if (role === 'mixed') return '路由 + 执行';
  return '未确认';
}
