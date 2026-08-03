import { createHash } from 'node:crypto';
import type {
  DebugKnowledgeAccessKind,
  DebugKnowledgeEvidence,
  DebugKnowledgeKind,
  ExperienceEvidenceRef,
  ExperienceSessionSummary,
  ExperienceTimelineEvent,
  KnowledgeDebuggerViewModel,
  ObservationReviewState,
} from '../types/index.js';

export type {
  DebugKnowledgeAccessKind,
  DebugKnowledgeEvidence,
  DebugKnowledgeKind,
  KnowledgeDebuggerViewModel,
};

interface DebugKnowledgeCandidate extends Omit<DebugKnowledgeEvidence, 'id' | 'accessCount' | 'evidenceRefs'> {
  evidenceRef: ExperienceEvidenceRef;
}

const AGENTS_CONTEXT_RE = /^# AGENTS\.md instructions for ([^\n]+)\n/gim;
const SKILL_PATH_RE = /((?:~|\.{0,2}|\/)?[^\s"'`]*\/skills\/(?:\.system\/)?([^/\s"'`]+)\/SKILL\.md)\b/i;
const MUTATING_TOOL_RE = /(?:^|[._-])(write|edit|delete|remove|move|rename|apply[_-]?patch)(?:$|[._-])/i;

export function buildKnowledgeDebuggerViewModel(
  session: ExperienceSessionSummary,
  reviewState?: ObservationReviewState,
  observationsDir?: string,
): KnowledgeDebuggerViewModel {
  return {
    session,
    observationsDir,
    knowledgeEvidence: projectKnowledgeEvidence(session.fullSessionTimeline),
    knowledgeGaps: reviewState
      ? Object.values(reviewState.entries)
        .filter((entry) => entry.targetType === 'knowledge_gap' && entry.experienceSessionId === session.id)
        .sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))
      : [],
  };
}

export function projectKnowledgeEvidence(
  timeline: ExperienceTimelineEvent[],
): DebugKnowledgeEvidence[] {
  const candidates: DebugKnowledgeCandidate[] = [];
  const toolCalls = new Map<string, ExperienceTimelineEvent>();

  for (const event of timeline) {
    if (event.kind === 'tool_use') {
      toolCalls.set(toolCorrelationKey(event), event);
      continue;
    }

    if (event.kind === 'runtime_context') {
      const text = event.fullText ?? event.snippet ?? '';
      const agentsMatches = [...text.matchAll(AGENTS_CONTEXT_RE)];
      for (const [index, agentsMatch] of agentsMatches.entries()) {
        if (!agentsMatch[1]) continue;
        const sectionStart = agentsMatch.index ?? 0;
        const sectionEnd = agentsMatches[index + 1]?.index ?? text.length;
        const section = text.slice(sectionStart, sectionEnd).trim();
        candidates.push({
          knowledgeKind: 'project_instruction',
          accessKind: 'injected',
          label: 'AGENTS.md',
          sourceLocator: `runtime-context:${agentsMatch[1].trim()}`,
          contentHash: contentHash(section),
          firstSeen: event.timestamp,
          lastSeen: event.timestamp,
          evidenceRef: evidenceRef(event),
        });
      }
      continue;
    }

    if (event.kind === 'skill_context') {
      const text = event.fullText ?? event.snippet ?? '';
      candidates.push({
        knowledgeKind: 'skill',
        accessKind: 'injected',
        label: event.label || 'Skill context',
        contentHash: text ? contentHash(text) : undefined,
        firstSeen: event.timestamp,
        lastSeen: event.timestamp,
        evidenceRef: evidenceRef(event),
      });
      continue;
    }

    if (event.kind !== 'tool_result') continue;
    const call = toolCalls.get(toolCorrelationKey(event));
    if (!call) continue;
    const output = event.fullText ?? event.snippet ?? '';
    if (!output.trim()) continue;

    const callText = call.fullText ?? call.snippet ?? '';
    const skillPath = SKILL_PATH_RE.exec(callText);
    if (skillPath?.[1] && skillPath[2]) {
      candidates.push({
        knowledgeKind: 'skill',
        accessKind: 'read',
        label: skillPath[2],
        sourceLocator: skillPath[1],
        contentHash: contentHash(output),
        firstSeen: event.timestamp ?? call.timestamp,
        lastSeen: event.timestamp ?? call.timestamp,
        evidenceRef: evidenceRef(event),
      });
      continue;
    }

    const toolName = call.toolName ?? call.label ?? 'tool';
    if (MUTATING_TOOL_RE.test(toolName)) continue;
    candidates.push({
      knowledgeKind: 'runtime_evidence',
      accessKind: 'returned',
      label: toolName,
      sourceLocator: sourceLocator(callText),
      contentHash: contentHash(output),
      firstSeen: event.timestamp ?? call.timestamp,
      lastSeen: event.timestamp ?? call.timestamp,
      evidenceRef: evidenceRef(event),
    });
  }

  return aggregateCandidates(candidates);
}

function aggregateCandidates(candidates: DebugKnowledgeCandidate[]): DebugKnowledgeEvidence[] {
  const aggregated = new Map<string, DebugKnowledgeEvidence>();
  for (const candidate of candidates) {
    const identity = [
      candidate.knowledgeKind,
      candidate.accessKind,
      candidate.sourceLocator ?? candidate.label,
      candidate.contentHash ?? '',
    ].join('\u0000');
    const id = `knowledge:${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
    const current = aggregated.get(id);
    if (current) {
      current.accessCount += 1;
      current.evidenceRefs.push(candidate.evidenceRef);
      if (candidate.firstSeen && (!current.firstSeen || candidate.firstSeen < current.firstSeen)) {
        current.firstSeen = candidate.firstSeen;
      }
      if (candidate.lastSeen && (!current.lastSeen || candidate.lastSeen > current.lastSeen)) {
        current.lastSeen = candidate.lastSeen;
      }
      continue;
    }
    aggregated.set(id, {
      id,
      knowledgeKind: candidate.knowledgeKind,
      accessKind: candidate.accessKind,
      label: candidate.label,
      sourceLocator: candidate.sourceLocator,
      contentHash: candidate.contentHash,
      firstSeen: candidate.firstSeen,
      lastSeen: candidate.lastSeen,
      accessCount: 1,
      evidenceRefs: [candidate.evidenceRef],
    });
  }
  return [...aggregated.values()].sort((a, b) => {
    const aTime = a.firstSeen ?? '';
    const bTime = b.firstSeen ?? '';
    return aTime.localeCompare(bTime) || a.label.localeCompare(b.label);
  });
}

function toolCorrelationKey(event: ExperienceTimelineEvent): string {
  return event.callInstanceId ?? event.toolUseId ?? event.id;
}

function sourceLocator(inputText: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputText) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const input = parsed as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'url', 'query', 'command', 'cmd']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500);
  }
  return undefined;
}

function contentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function evidenceRef(event: ExperienceTimelineEvent): ExperienceEvidenceRef {
  return {
    id: event.id,
    kind: event.kind,
    traceId: event.traceId,
    sourceTrace: event.sourceTrace,
    sessionId: event.sessionId,
    traceRole: event.traceRole,
    traceLabel: event.traceLabel,
    messageIndex: event.messageIndex,
    logicalMessageIndex: event.logicalMessageIndex,
    sourceLineIndex: event.sourceLineIndex,
    messageUuid: event.messageUuid,
    callInstanceId: event.callInstanceId,
    toolUseId: event.toolUseId,
    timestamp: event.timestamp,
    role: event.role,
    label: event.label,
    snippet: event.snippet,
  };
}
