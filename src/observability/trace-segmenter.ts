/** Skill segmentation and ResultEntry projection for loaded traces. */

import { createHash } from 'node:crypto';
import type { ResultEntry, ToolCallInfo, TraceSourceMetadata, TurnInfo, VariantResult } from '../types/index.js';
import { legacyCcSessionToTraceSession, type CcSession } from './trace-source.js';
import type { TraceSession } from './trace-ir.js';
import { traceToolDisplayName } from './trace-ir.js';
import {
  extractAttributionSkillRefFromEvent,
  extractBusinessActionSkillRefFromEvent,
  extractCommandSkillRefFromEvent,
  extractSkillReadFileRefFromEvent,
  extractSkillScriptCommandRefFromEvent,
  extractSkillToolUseRefFromEvent,
  stripCommandEnvelopeText,
  type SkillRef,
} from './trace-attribution.js';

export interface SkillSegment {
  skillName: string;
  attribution?: {
    source: 'skill-tool' | 'command-name' | 'business-action' | 'read-skill-md' | 'skill-script' | 'general';
    confidence: number;
    rawSkillRef?: string;
    pluginName?: string;
    commandName?: string;
  };
  sessionId: string;
  traceSessionId?: string;
  traceId?: string;
  sourceTrace?: string;
  sourceKind?: 'claude' | 'codex' | 'openclaw' | 'markdown_log' | 'unknown';
  traceRole?: 'standalone' | 'main' | 'subagent';
  traceLabel?: string;
  sourceMetadata?: TraceSourceMetadata;
  segmentIndex: number;
  startRecordIndex?: number;
  endRecordIndex?: number;
  startTimestamp: string;
  endTimestamp: string;
  cwd?: string;
  turns: TurnInfo[];
  toolCalls: ToolCallInfo[];
  metrics: {
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    numTurns: number;
    numToolCalls: number;
    numToolFailures: number;
  };
}

// ---------- Segment by skill ----------

/**
 * 扫描 Trace IR events, 按 skill 信号把 tool calls 切成多段。
 * 一个 session 可能产生 1-N 个 SkillSegment。
 */
export function segmentTraceBySkill(session: TraceSession): SkillSegment[] {
  const segments: SkillSegment[] = [];
  let currentSkill = 'general';
  let currentSkillSource: string | undefined;
  let currentSegment = createEmptySegment(session, currentSkill, 0, 0);
  let segmentIndex = 0;
  const lastSourceIndex = session.events.at(-1)?.sourceIndex ?? 0;

  const pendingToolUses = new Map<string, { toolCall: ToolCallInfo; segmentRef: SkillSegment }>();
  const assistantTurnsBySourceIndex = new Map<number, TurnInfo>();

  const markCurrentRecord = (recordIndex: number): void => {
    currentSegment.endRecordIndex = Math.max(
      currentSegment.endRecordIndex ?? currentSegment.startRecordIndex ?? recordIndex,
      recordIndex,
    );
  };

  const flushCurrent = (endRecordIndex?: number): boolean => {
    if (currentSegment.turns.length > 0 || currentSegment.toolCalls.length > 0) {
      if (typeof endRecordIndex === 'number') {
        const start = currentSegment.startRecordIndex ?? 0;
        currentSegment.endRecordIndex = Math.max(start, Math.min(lastSourceIndex, endRecordIndex));
      }
      segments.push(currentSegment);
      return true;
    }
    return false;
  };

  const isCurrentSkillRef = (ref: SkillRef): boolean =>
    ref.skillName === currentSkill && (ref.pluginName ?? '') === (currentSkillSource ?? '');

  const startNewSegment = (ref: SkillRef, recordIndex: number, timestamp?: string, attribution?: SkillSegment['attribution']): void => {
    // 空段被新信号替换时,不推进 segmentIndex(保持整洁的 0-based 编号)
    const wasNonEmpty = flushCurrent(recordIndex - 1);
    if (wasNonEmpty) segmentIndex += 1;
    currentSegment = createEmptySegment(session, ref.skillName, segmentIndex, recordIndex, timestamp, attribution);
    currentSkill = ref.skillName;
    currentSkillSource = ref.pluginName;
  };

  for (const event of session.events) {
    const recordIndex = event.sourceIndex;
    if (event.eventKind === 'message' && event.role === 'user') {
      const cmdSkill = event.origin === 'human' ? extractCommandSkillRefFromEvent(event) : null;
      if (cmdSkill && !isCurrentSkillRef(cmdSkill)) {
        startNewSegment(cmdSkill, recordIndex, event.timestamp, {
          source: 'command-name',
          confidence: 0.85,
          rawSkillRef: cmdSkill.rawSkillRef,
          pluginName: cmdSkill.pluginName,
          commandName: `/${cmdSkill.rawSkillRef}`,
        });
      } else if (!cmdSkill) {
        const businessActionSkill = event.origin === 'human'
          ? extractBusinessActionSkillRefFromEvent(event)
          : null;
        if (businessActionSkill && !isCurrentSkillRef(businessActionSkill)) {
          startNewSegment(businessActionSkill, recordIndex, event.timestamp, {
            source: 'business-action',
            confidence: 0.85,
            rawSkillRef: businessActionSkill.rawSkillRef,
            pluginName: businessActionSkill.pluginName,
            commandName: businessActionSkill.rawSkillRef,
          });
        } else {
          const scriptSkill = event.origin === 'human'
            ? extractSkillScriptCommandRefFromEvent(event)
            : null;
          if (scriptSkill && !isCurrentSkillRef(scriptSkill)) {
            startNewSegment(scriptSkill, recordIndex, event.timestamp, {
              source: 'skill-script',
              confidence: 0.75,
              rawSkillRef: scriptSkill.rawSkillRef,
              pluginName: scriptSkill.pluginName,
              commandName: scriptSkill.rawSkillRef,
            });
          }
        }
      }
      if (event.origin === 'human') {
        const textContent = stripCommandEnvelopeText(event.text);
        if (textContent) {
          currentSegment.turns.push({ role: 'tool', content: textContent });
          currentSegment.metrics.numTurns += 1;
        }
      }
      updateSegmentTimestamp(currentSegment, event.timestamp);
      markCurrentRecord(recordIndex);
      continue;
    }

    if (event.eventKind === 'message' && event.role === 'assistant') {
      const attrSkill = extractAttributionSkillRefFromEvent(event);
      if (attrSkill && !isCurrentSkillRef(attrSkill)) {
        startNewSegment(attrSkill, recordIndex, event.timestamp, {
          source: 'command-name',
          confidence: 0.85,
          rawSkillRef: attrSkill.rawSkillRef,
          pluginName: attrSkill.pluginName,
          commandName: `/${attrSkill.rawSkillRef}`,
        });
      } else {
        const scriptSkill = extractSkillScriptCommandRefFromEvent(event);
        if (scriptSkill && !isCurrentSkillRef(scriptSkill)) {
          startNewSegment(scriptSkill, recordIndex, event.timestamp, {
            source: 'skill-script',
            confidence: 0.7,
            rawSkillRef: scriptSkill.rawSkillRef,
            pluginName: scriptSkill.pluginName,
            commandName: scriptSkill.rawSkillRef,
          });
        }
      }
      updateSegmentSourceModel(currentSegment, session.sourceMetadata, event.model);
      if (event.text) {
        const turn: TurnInfo = { role: 'assistant', content: event.text };
        currentSegment.turns.push(turn);
        assistantTurnsBySourceIndex.set(recordIndex, turn);
        currentSegment.metrics.numTurns += 1;
      }
      updateSegmentTimestamp(currentSegment, event.timestamp);
      markCurrentRecord(recordIndex);
      continue;
    }

    if (event.eventKind === 'tool_call') {
      const skillTool = extractSkillToolUseRefFromEvent(event);
      if (skillTool && !isCurrentSkillRef(skillTool)) {
        startNewSegment(skillTool, recordIndex, event.timestamp, {
          source: 'skill-tool',
          confidence: 0.95,
          rawSkillRef: skillTool.rawSkillRef,
          pluginName: skillTool.pluginName,
        });
      } else if (!skillTool) {
        const scriptSkill = extractSkillScriptCommandRefFromEvent(event);
        if (scriptSkill && !isCurrentSkillRef(scriptSkill)) {
          startNewSegment(scriptSkill, recordIndex, event.timestamp, {
            source: 'skill-script',
            confidence: 0.7,
            rawSkillRef: scriptSkill.rawSkillRef,
            pluginName: scriptSkill.pluginName,
            commandName: scriptSkill.rawSkillRef,
          });
        } else {
          const readSkill = extractSkillReadFileRefFromEvent(event);
          if (readSkill && !isCurrentSkillRef(readSkill) && shouldCutOnReadSkill(session, currentSegment)) {
            startNewSegment(readSkill, recordIndex, event.timestamp, {
              source: 'read-skill-md',
              confidence: 0.5,
              rawSkillRef: readSkill.rawSkillRef,
              pluginName: readSkill.pluginName,
            });
          }
        }
      }
      updateSegmentSourceModel(currentSegment, session.sourceMetadata, event.model);
      const toolCall: ToolCallInfo = {
        tool: traceToolDisplayName(event.tool),
        input: event.input,
        output: '',
        success: true,
        messageIndex: recordIndex,
        messageUuid: event.sourceEventId ?? event.eventId,
        toolUseId: event.callId,
        timestamp: event.timestamp,
        sourceTrace: session.sourcePath,
        sourceKind: session.sourceKind,
        traceRole: session.role,
        traceLabel: session.label,
      };
      currentSegment.toolCalls.push(toolCall);
      currentSegment.metrics.numToolCalls += 1;
      pendingToolUses.set(event.callId, { toolCall, segmentRef: currentSegment });

      let turn = assistantTurnsBySourceIndex.get(recordIndex);
      if (!turn || !currentSegment.turns.includes(turn)) {
        turn = { role: 'assistant', content: '' };
        currentSegment.turns.push(turn);
        assistantTurnsBySourceIndex.set(recordIndex, turn);
        currentSegment.metrics.numTurns += 1;
      }
      turn.toolCalls = [...(turn.toolCalls ?? []), toolCall];
      updateSegmentTimestamp(currentSegment, event.timestamp);
      markCurrentRecord(recordIndex);
      continue;
    }

    if (event.eventKind === 'tool_result') {
      const pending = pendingToolUses.get(event.callId);
      if (pending) {
        const failed = event.status === 'failure' || event.status === 'cancelled';
        pending.toolCall.output = event.output;
        pending.toolCall.success = !failed;
        if (failed) pending.segmentRef.metrics.numToolFailures += 1;
        pendingToolUses.delete(event.callId);
      }
      updateSegmentTimestamp(currentSegment, event.timestamp);
      markCurrentRecord(recordIndex);
      continue;
    }

    if (event.eventKind === 'usage') {
      currentSegment.metrics.inputTokens += event.inputTokens;
      currentSegment.metrics.outputTokens += event.outputTokens;
      currentSegment.metrics.cacheReadTokens += event.cacheReadTokens;
      currentSegment.metrics.cacheCreationTokens += event.cacheCreationTokens;
      updateSegmentSourceModel(currentSegment, session.sourceMetadata, event.model);
      updateSegmentTimestamp(currentSegment, event.timestamp);
    }
    markCurrentRecord(recordIndex);
  }

  flushCurrent(lastSourceIndex);
  return segments;
}

/** @deprecated Compatibility entry point for Claude-shaped fixtures. */
export function segmentBySkill(session: TraceSession | CcSession): SkillSegment[] {
  return segmentTraceBySkill('events' in session ? session : legacyCcSessionToTraceSession(session));
}

function updateSegmentSourceModel(
  segment: SkillSegment,
  sessionMetadata: TraceSourceMetadata | undefined,
  model: string | undefined,
): void {
  if (segment.sourceKind !== 'codex' || !model) return;
  const baseMetadata = { ...sessionMetadata };
  delete baseMetadata.model;
  const models = new Set(
    segment.sourceMetadata?.model?.split(', ').filter(Boolean) ?? [],
  );
  models.add(model);
  segment.sourceMetadata = {
    ...baseMetadata,
    ...segment.sourceMetadata,
    model: Array.from(models).join(', '),
  };
}

function createEmptySegment(session: TraceSession, skillName: string, index: number, recordIndex: number, timestamp?: string, attribution?: SkillSegment['attribution']): SkillSegment {
  const ts = timestamp ?? session.startTimestamp ?? new Date().toISOString();
  return {
    skillName,
    attribution: attribution ?? { source: 'general', confidence: 0.3 },
    sessionId: session.rootRunId,
    traceSessionId: session.runId,
    traceId: session.traceId,
    sourceTrace: session.sourcePath,
    sourceKind: session.sourceKind,
    traceRole: session.role,
    traceLabel: session.label,
    segmentIndex: index,
    startRecordIndex: recordIndex,
    endRecordIndex: recordIndex,
    startTimestamp: ts,
    endTimestamp: ts,
    cwd: session.cwd,
    turns: [],
    toolCalls: [],
    metrics: {
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      numTurns: 0,
      numToolCalls: 0,
      numToolFailures: 0,
    },
  };
}

function updateSegmentTimestamp(seg: SkillSegment, timestamp?: string): void {
  if (!timestamp) return;
  if (!seg.endTimestamp || timestamp > seg.endTimestamp) seg.endTimestamp = timestamp;
  // 重算 durationMs
  try {
    const start = new Date(seg.startTimestamp).getTime();
    const end = new Date(seg.endTimestamp).getTime();
    if (!Number.isNaN(start) && !Number.isNaN(end)) seg.metrics.durationMs = Math.max(0, end - start);
  } catch { /* skip */ }
}

function shouldCutOnReadSkill(session: TraceSession, currentSegment: SkillSegment): boolean {
  return currentSegment.skillName === 'general'
    || currentSegment.attribution?.source === 'read-skill-md'
    || session.sourceKind === 'openclaw'
    || session.sourceKind === 'codex';
}

// ---------- Segment → ResultEntry ----------

/**
 * SkillSegment[] → ResultEntry[] (omk 内部分析路径的标准输入)。
 *
 * 映射规则(详见 docs/skill-health-spec.md):
 *   - 每 segment 一个 ResultEntry
 *   - sample_id = `${traceId}:${segmentIndex}`
 *   - variant key = skill 名(复用 omk 的 variant 维度作为 skill 分组维度)
 */
export function segmentsToResultEntries(segments: SkillSegment[]): ResultEntry[] {
  return segments.map((seg): ResultEntry => ({
    sample_id: `trace:${createHash('sha256')
      .update(seg.traceId ?? seg.traceSessionId ?? seg.sessionId)
      .digest('hex')
      .slice(0, 16)}:${seg.segmentIndex}`,
    variants: {
      [seg.skillName]: buildVariantResult(seg),
    },
  }));
}

function buildVariantResult(seg: SkillSegment): VariantResult {
  const totalTokens = seg.metrics.inputTokens + seg.metrics.outputTokens;
  const toolSuccessRate = seg.metrics.numToolCalls > 0
    ? (seg.metrics.numToolCalls - seg.metrics.numToolFailures) / seg.metrics.numToolCalls
    : 1;
  return {
    ok: true,
    durationMs: seg.metrics.durationMs,
    durationApiMs: seg.metrics.durationMs,
    inputTokens: seg.metrics.inputTokens,
    outputTokens: seg.metrics.outputTokens,
    totalTokens,
    cacheReadTokens: seg.metrics.cacheReadTokens,
    cacheCreationTokens: seg.metrics.cacheCreationTokens,
    execCostUSD: 0,
    judgeCostUSD: 0,
    costUSD: 0,
    numTurns: seg.metrics.numTurns,
    numToolCalls: seg.metrics.numToolCalls,
    numToolFailures: seg.metrics.numToolFailures,
    toolSuccessRate,
    toolNames: Array.from(new Set(seg.toolCalls.map((tc) => tc.tool))),
    outputPreview: null,
    turns: seg.turns,
    toolCalls: seg.toolCalls,
  };
}
