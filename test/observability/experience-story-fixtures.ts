/**
 * 会话故事用例的共用夹具：只构造被测判定实际读取的字段。
 *
 * 主线 / 子会话两条物理 trace 是这一层几乎所有归属规则的分界，所以固定成常量；
 * 时间戳按 messageIndex 秒级递增，让「父辈必须早于分支启动」这类时序规则可被写成用例。
 */
import type {
  ExperienceEvidenceRef,
  ExperienceInvocation,
  ExperienceSessionStorySubagentDispatch,
  ExperienceSessionSummary,
  ExperienceSkillSegment,
  ExperienceTimelineBranch,
  ExperienceTimelineEvent,
  ExperienceTimelineTree,
} from '../../src/observability/experience.js';

export const MAIN_TRACE = 'trace-main';
export const MAIN_SOURCE = 'session-main.jsonl';
export const MAIN_SESSION = 'session-main';
export const CHILD_TRACE = 'trace-child';
export const CHILD_SOURCE = 'session-child.jsonl';
export const CHILD_SESSION = 'session-child';

export const at = (seconds: number): string => new Date(Date.UTC(2026, 8, 1, 0, 0, seconds)).toISOString();

let eventSeq = 0;

export function event(
  over: Partial<ExperienceTimelineEvent> & Pick<ExperienceTimelineEvent, 'kind'>,
): ExperienceTimelineEvent {
  eventSeq += 1;
  const messageIndex = over.messageIndex ?? eventSeq;
  return {
    id: `evt-${eventSeq}`,
    order: messageIndex,
    sourceTrace: MAIN_SOURCE,
    sessionId: MAIN_SESSION,
    traceId: MAIN_TRACE,
    traceRole: 'main',
    timestamp: at(messageIndex),
    messageIndex,
    ...over,
  };
}

export function refOf(
  target: Pick<ExperienceTimelineEvent, 'id' | 'kind' | 'messageIndex' | 'traceId' | 'sourceTrace' | 'sessionId' | 'timestamp'>,
): ExperienceEvidenceRef {
  return {
    id: target.id,
    kind: target.kind,
    messageIndex: target.messageIndex,
    traceId: target.traceId,
    sourceTrace: target.sourceTrace,
    sessionId: target.sessionId,
    timestamp: target.timestamp,
  };
}

/** 只填段窗口、顺序、身份与角色：编排边和反馈归因不读其余字段。 */
export function segment(
  over: Partial<ExperienceSkillSegment> & Pick<ExperienceSkillSegment, 'id' | 'order' | 'skillName'>,
): ExperienceSkillSegment {
  return {
    skillType: 'unknown',
    episodeRole: 'supporting',
    skillInvocationIds: [`inv-${over.id}`],
    startTimestamp: at(0),
    endTimestamp: at(60),
    typeSpecificChecklist: [],
    evidenceRefs: [],
    ...over,
  } as ExperienceSkillSegment;
}

type MainlineSeed = Pick<ExperienceSkillSegment, 'id' | 'order' | 'skillName'> & {
  startMessageIndex: number;
  endMessageIndex?: number;
};

export function mainlineSegment(
  over: Partial<ExperienceSkillSegment> & MainlineSeed,
): ExperienceSkillSegment {
  const end = over.endMessageIndex ?? over.startMessageIndex + 10;
  const scope = over.messageRanges?.[0];
  return segment({
    ...over,
    endMessageIndex: end,
    startTimestamp: at(over.startMessageIndex),
    endTimestamp: at(end),
    messageRanges: [{
      startMessageIndex: over.startMessageIndex,
      endMessageIndex: end,
      traceId: scope?.traceId ?? MAIN_TRACE,
      sourceTrace: scope?.sourceTrace ?? MAIN_SOURCE,
      sessionId: scope?.sessionId ?? MAIN_SESSION,
    }],
  });
}

export function invocationsOf(timeline: ExperienceTimelineEvent[]): ExperienceInvocation[] {
  return [{ id: 'inv-1', skillName: 'omk', timeline }] as unknown as ExperienceInvocation[];
}

/** 被测函数只读取 session 上的 timelineTree，其余字段与本组用例无关。 */
export function sessionOf(tree: ExperienceTimelineTree): ExperienceSessionSummary {
  return { id: 'session-1', sessionId: MAIN_SESSION, timelineTree: tree } as unknown as ExperienceSessionSummary;
}

export function dispatchOf(
  over: Partial<ExperienceSessionStorySubagentDispatch> & Pick<ExperienceSessionStorySubagentDispatch, 'id' | 'branchId'>,
): ExperienceSessionStorySubagentDispatch {
  return {
    order: 1,
    childSessionId: CHILD_SESSION,
    traceId: CHILD_TRACE,
    sourceTrace: CHILD_SOURCE,
    label: 'branch',
    eventCount: 1,
    evidenceRefs: [],
    ...over,
  } as ExperienceSessionStorySubagentDispatch;
}

export function branchOf(
  over: Partial<ExperienceTimelineBranch> & Pick<ExperienceTimelineBranch, 'id' | 'events'>,
): ExperienceTimelineBranch {
  return {
    label: 'branch',
    sessionId: CHILD_SESSION,
    sourceTrace: CHILD_SOURCE,
    traceRole: 'subagent',
    ...over,
  };
}

export const routerSegment = (over: Partial<ExperienceSkillSegment> = {}): ExperienceSkillSegment => mainlineSegment({
  id: 'seg-router',
  order: 1,
  skillName: 'omk',
  startMessageIndex: 0,
  endMessageIndex: 20,
  skillType: 'router',
  episodeRole: 'router',
  ...over,
});

export const childExecutorSegment = (): ExperienceSkillSegment => segment({
  id: 'seg-executor',
  order: 2,
  skillName: 'deep-review',
  skillType: 'executor',
  episodeRole: 'main_executor',
  startTimestamp: at(30),
  endTimestamp: at(40),
  messageRanges: [{
    startMessageIndex: 0,
    endMessageIndex: 10,
    traceId: CHILD_TRACE,
    sourceTrace: CHILD_SOURCE,
    sessionId: CHILD_SESSION,
  }],
});
