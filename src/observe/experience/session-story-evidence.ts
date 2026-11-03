/**
 * 会话故事的共享证据定位层：证据引用与技能段、消息窗口、物理 trace 作用域之间的匹配判据，
 * 以及「这条时间线事件算不算一次编排启动」的识别规则（段与角色、编排边两族都要用）。
 */
import type {
  ExperienceEvidenceRef,
  ExperienceMessageRange,
  ExperienceSkillSegment,
  ExperienceTimelineEvent,
} from '../contracts/experience.js';

export function skillSegmentForTrace(
  skillSegments: ExperienceSkillSegment[],
  traceId: string,
  sourceTrace: string,
): ExperienceSkillSegment | undefined {
  return skillSegments
    .filter((segment) =>
      (segment.messageRanges ?? []).some((range) =>
        range.traceId === traceId || range.sourceTrace === sourceTrace
      )
      || segment.evidenceRefs.some((ref) =>
        ref.traceId === traceId || ref.sourceTrace === sourceTrace
      )
    )
    .sort((a, b) => a.order - b.order)[0];
}

export function isOrchestrationRuntimeEvent(event: ExperienceTimelineEvent): boolean {
  const text = `${event.toolName ?? ''} ${event.snippet ?? ''} ${event.fullText ?? ''}`;
  if (event.kind === 'tool_use') {
    return /^(?:Task|Agent)$/i.test(event.toolName ?? '')
      || /runner\.js|send-input\.js|check-session\.js/i.test(text);
  }
  if (event.kind === 'assistant_message') {
    return /ttyd|(?:已启动|启动了|spawned|started).{0,80}(?:subagent|sub-agent|child agent|子\s*(?:agent|代理|智能体|Claude|Codex))|(?:subagent|sub-agent|child agent|子\s*(?:agent|代理|智能体|Claude|Codex)).{0,48}(?:已启动|启动中|正在(?:执行|运行|分析)|spawned|started|running)/i.test(text)
      || /\b(?:session|thread|agent)(?:\s+id)?\s*[:=]\s*[a-z0-9][a-z0-9._-]*/i.test(text);
  }
  return false;
}

export function skillSegmentForEvidenceRef(
  evidenceRef: ExperienceEvidenceRef,
  skillSegments: ExperienceSkillSegment[],
  preferredSkillName?: string,
): ExperienceSkillSegment | undefined {
  const messageIndex = evidenceRef.messageIndex;
  if (typeof messageIndex !== 'number') return undefined;
  const candidates = skillSegments
    .map((segment) => {
      const ranges = segment.messageRanges?.length
        ? segment.messageRanges
        : typeof segment.startMessageIndex === 'number' && typeof segment.endMessageIndex === 'number'
          ? [{ startMessageIndex: segment.startMessageIndex, endMessageIndex: segment.endMessageIndex }]
          : [];
      const matchedRange = ranges.find((range) =>
        messageRangeContainsEvidenceRef(range, evidenceRef)
      );
      return matchedRange ? {
        segment,
        rangeSize: matchedRange.endMessageIndex - matchedRange.startMessageIndex,
        traceSpecificity: messageRangeTraceSpecificity(matchedRange, evidenceRef),
        preferred: preferredSkillName ? segment.skillName === preferredSkillName : false,
        startsHere: messageIndex === matchedRange.startMessageIndex,
      } : undefined;
    })
    .filter((value): value is { segment: ExperienceSkillSegment; rangeSize: number; traceSpecificity: number; preferred: boolean; startsHere: boolean } => Boolean(value))
    .sort((a, b) =>
      Number(b.preferred) - Number(a.preferred)
      || b.traceSpecificity - a.traceSpecificity
      || Number(b.startsHere) - Number(a.startsHere)
      || a.rangeSize - b.rangeSize
      || a.segment.order - b.segment.order
    );
  return candidates[0]?.segment;
}

function messageRangeContainsEvidenceRef(
  range: ExperienceMessageRange,
  ref: Pick<ExperienceEvidenceRef, 'messageIndex' | 'traceId' | 'sourceTrace' | 'sessionId'>,
): boolean {
  if (typeof ref.messageIndex !== 'number') return false;
  if (range.traceId && ref.traceId && range.traceId !== ref.traceId) return false;
  if (range.sourceTrace && ref.sourceTrace && range.sourceTrace !== ref.sourceTrace) return false;
  if (range.sessionId && ref.sessionId && range.sessionId !== ref.sessionId) return false;
  return ref.messageIndex >= range.startMessageIndex && ref.messageIndex <= range.endMessageIndex;
}

function messageRangeTraceSpecificity(
  range: ExperienceMessageRange,
  ref: Pick<ExperienceEvidenceRef, 'traceId' | 'sourceTrace' | 'sessionId'>,
): number {
  return (range.traceId && ref.traceId && range.traceId === ref.traceId ? 4 : 0)
    + (range.sourceTrace && ref.sourceTrace && range.sourceTrace === ref.sourceTrace ? 2 : 0)
    + (range.sessionId && ref.sessionId && range.sessionId === ref.sessionId ? 1 : 0);
}

export function evidenceRefsShareTraceScope(
  a?: Pick<ExperienceEvidenceRef, 'traceId' | 'sourceTrace' | 'sessionId'>,
  b?: Pick<ExperienceEvidenceRef, 'traceId' | 'sourceTrace' | 'sessionId'>,
): boolean {
  if (!a || !b) return true;
  if (a.traceId && b.traceId && a.traceId !== b.traceId) return false;
  if (a.sourceTrace && b.sourceTrace && a.sourceTrace !== b.sourceTrace) return false;
  if (a.sessionId && b.sessionId && a.sessionId !== b.sessionId) return false;
  return true;
}

export function timelineEventSharesTraceScope(
  event: Pick<ExperienceTimelineEvent, 'traceId' | 'sourceTrace' | 'sessionId'>,
  anchor?: Pick<ExperienceTimelineEvent, 'traceId' | 'sourceTrace' | 'sessionId'>,
): boolean {
  return evidenceRefsShareTraceScope(event, anchor);
}

export function skillSegmentsSharePhysicalTrace(a: ExperienceSkillSegment, b: ExperienceSkillSegment): boolean {
  const aTraceIds = new Set((a.messageRanges ?? []).map((range) => range.traceId).filter((value): value is string => Boolean(value)));
  const bTraceIds = new Set((b.messageRanges ?? []).map((range) => range.traceId).filter((value): value is string => Boolean(value)));
  if (aTraceIds.size > 0 && bTraceIds.size > 0) {
    return Array.from(aTraceIds).some((traceId) => bTraceIds.has(traceId));
  }
  const aTraces = new Set((a.messageRanges ?? []).map((range) => range.sourceTrace).filter((value): value is string => Boolean(value)));
  const bTraces = new Set((b.messageRanges ?? []).map((range) => range.sourceTrace).filter((value): value is string => Boolean(value)));
  if (aTraces.size === 0 || bTraces.size === 0) return true;
  return Array.from(aTraces).some((trace) => bTraces.has(trace));
}
