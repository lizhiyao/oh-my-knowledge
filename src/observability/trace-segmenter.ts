/** Skill segmentation and ResultEntry projection for loaded traces. */

import type { ResultEntry, ToolCallInfo, TurnInfo, VariantResult } from '../types/index.js';
import type { CcAssistantRecord, CcSession, CcUserRecord } from './trace-source.js';
import {
  extractAimaCmdSkillRef,
  extractAttributionSkillRef,
  extractCommandSkillRef,
  extractSkillReadFileRef,
  extractSkillToolUseRef,
  stripCommandEnvelopeText,
  type SkillRef,
} from './trace-attribution.js';

export interface SkillSegment {
  skillName: string;
  attribution?: {
    source: 'skill-tool' | 'command-name' | 'aima-cmd' | 'read-skill-md' | 'general';
    confidence: number;
    rawSkillRef?: string;
    pluginName?: string;
    commandName?: string;
  };
  sessionId: string;
  traceSessionId?: string;
  sourceTrace?: string;
  sourceKind?: 'claude' | 'openclaw' | 'markdown_log' | 'unknown';
  traceRole?: 'standalone' | 'main' | 'subagent';
  traceLabel?: string;
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
 * 扫描 session records, 按 skill 信号把 tool calls 切成多段。
 * 一个 session 可能产生 1-N 个 SkillSegment。
 */
export function segmentBySkill(session: CcSession): SkillSegment[] {
  const segments: SkillSegment[] = [];
  let currentSkill = 'general';
  let currentSkillSource: string | undefined;
  let currentSegment = createEmptySegment(session, currentSkill, 0, 0);
  let segmentIndex = 0;

  // 用 tool_use_id → ToolCallInfo 的映射, 收到 tool_result 时回填 output / success
  const pendingToolUses = new Map<string, { toolCall: ToolCallInfo; segmentRef: SkillSegment }>();

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
        currentSegment.endRecordIndex = Math.max(start, Math.min(session.records.length - 1, endRecordIndex));
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

  for (const [recordIndex, raw] of session.records.entries()) {
    // records 是 unknown[], 按 type 字段做 structural type guard
    if (!raw || typeof raw !== 'object' || !('type' in raw)) continue;
    const rec = raw as { type: string };
    if (rec.type === 'user') {
      const u = rec as CcUserRecord;
      // 检测 skill 信号 2 (slash command)
      const cmdSkill = extractCommandSkillRef(u);
      if (cmdSkill && !isCurrentSkillRef(cmdSkill)) {
        startNewSegment(cmdSkill, recordIndex, u.timestamp, {
          source: 'command-name',
          confidence: 0.85,
          rawSkillRef: cmdSkill.rawSkillRef,
          pluginName: cmdSkill.pluginName,
          commandName: `/${cmdSkill.rawSkillRef}`,
        });
      } else if (!cmdSkill) {
        const aimaCmdSkill = extractAimaCmdSkillRef(u);
        if (aimaCmdSkill && !isCurrentSkillRef(aimaCmdSkill)) {
          startNewSegment(aimaCmdSkill, recordIndex, u.timestamp, {
            source: 'aima-cmd',
            confidence: 0.85,
            rawSkillRef: aimaCmdSkill.rawSkillRef,
            pluginName: aimaCmdSkill.pluginName,
            commandName: aimaCmdSkill.rawSkillRef,
          });
        }
      }
      // 处理 tool_result(回填之前的 tool_use)
      if (typeof u.message.content !== 'string') {
        for (const part of u.message.content) {
          if (part.type === 'tool_result') {
            const pending = pendingToolUses.get(part.tool_use_id);
            if (pending) {
              pending.toolCall.output = part.content;
              pending.toolCall.success = part.is_error !== true;
              if (part.is_error === true) {
                pending.segmentRef.metrics.numToolFailures += 1;
              }
              pendingToolUses.delete(part.tool_use_id);
            }
          }
        }
      }
      // user text 合并到 tool turn(简化处理, 不强区分角色)
      const textContent = extractUserText(u);
      if (textContent) {
        currentSegment.turns.push({ role: 'tool', content: textContent });
        currentSegment.metrics.numTurns += 1;
      }
      updateSegmentTimestamp(currentSegment, u.timestamp);
      markCurrentRecord(recordIndex);
      continue;
    }
    if (rec.type === 'assistant') {
      const a = rec as CcAssistantRecord;
      // 检测 skill 信号 1 (Skill tool_use); 信号 3 (Read SKILL.md) 作 fallback。
      // OpenClaw/AIMA 场景里一条用户消息可能包含多个业务动作(如 生成PRD + 生成Demo),
      // 后续读取不同 SKILL.md 才是实际运行到哪个 skill 的稳定边界。
      const skillTool = extractSkillToolUseRef(a);
      if (skillTool && !isCurrentSkillRef(skillTool)) {
        startNewSegment(skillTool, recordIndex, a.timestamp, {
          source: 'skill-tool',
          confidence: 0.95,
          rawSkillRef: skillTool.rawSkillRef,
          pluginName: skillTool.pluginName,
        });
      } else if (!skillTool) {
        const attrSkill = extractAttributionSkillRef(a);
        if (attrSkill && !isCurrentSkillRef(attrSkill)) {
          startNewSegment(attrSkill, recordIndex, a.timestamp, {
            source: 'command-name',
            confidence: 0.85,
            rawSkillRef: attrSkill.rawSkillRef,
            pluginName: attrSkill.pluginName,
            commandName: `/${attrSkill.rawSkillRef}`,
          });
        } else {
          const readSkill = extractSkillReadFileRef(a);
          if (readSkill && !isCurrentSkillRef(readSkill) && shouldCutOnReadSkill(session, currentSegment)) {
            startNewSegment(readSkill, recordIndex, a.timestamp, {
              source: 'read-skill-md',
              confidence: 0.5,
              rawSkillRef: readSkill.rawSkillRef,
              pluginName: readSkill.pluginName,
            });
          }
        }
      }
      // 提取 tool_use → ToolCallInfo(success 先标 true, 等 tool_result 回填)
      const toolCalls: ToolCallInfo[] = [];
      let assistantText = '';
      const assistantContent = Array.isArray(a.message.content) ? a.message.content : [];
      for (const part of assistantContent) {
        if (part.type === 'text' && part.text) assistantText += part.text;
        if (part.type === 'tool_use' && part.id && part.name) {
          const tc: ToolCallInfo = {
            tool: part.name,
            input: part.input ?? {},
            output: '',
            success: true,
            messageIndex: recordIndex,
            messageUuid: a.uuid,
            toolUseId: part.id,
            timestamp: a.timestamp,
            sourceTrace: session.sourcePath,
            sourceKind: session.sourceKind,
            traceRole: session.traceRole,
            traceLabel: session.traceLabel,
          };
          toolCalls.push(tc);
          pendingToolUses.set(part.id, { toolCall: tc, segmentRef: currentSegment });
        }
      }
      if (toolCalls.length > 0 || assistantText) {
        currentSegment.turns.push({
          role: 'assistant',
          content: assistantText,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        });
        currentSegment.metrics.numTurns += 1;
        currentSegment.toolCalls.push(...toolCalls);
        currentSegment.metrics.numToolCalls += toolCalls.length;
      }
      // 累加 token usage
      const usage = a.message.usage;
      if (usage) {
        currentSegment.metrics.inputTokens += usage.input_tokens ?? 0;
        currentSegment.metrics.outputTokens += usage.output_tokens ?? 0;
        currentSegment.metrics.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        currentSegment.metrics.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
      }
      updateSegmentTimestamp(currentSegment, a.timestamp);
      markCurrentRecord(recordIndex);
      continue;
    }
    // 其他 type(permission-mode / file-history-snapshot) 不产出事件,但仍属于当前
    // skill 生命周期窗口,用于保持下一次 skill 边界前的连续上下文。
    markCurrentRecord(recordIndex);
  }

  flushCurrent(session.records.length - 1);
  // 孤儿 tool_use(没对应 tool_result 的)保持 success=true, 但标记为未闭合
  return segments;
}

function createEmptySegment(session: CcSession, skillName: string, index: number, recordIndex: number, timestamp?: string, attribution?: SkillSegment['attribution']): SkillSegment {
  const ts = timestamp ?? session.startTimestamp ?? new Date().toISOString();
  return {
    skillName,
    attribution: attribution ?? { source: 'general', confidence: 0.3 },
    sessionId: session.sessionGroupId ?? session.sessionId,
    traceSessionId: session.sessionId,
    sourceTrace: session.sourcePath,
    sourceKind: session.sourceKind,
    traceRole: session.traceRole,
    traceLabel: session.traceLabel,
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

function shouldCutOnReadSkill(session: CcSession, currentSegment: SkillSegment): boolean {
  return currentSegment.skillName === 'general'
    || currentSegment.attribution?.source === 'read-skill-md'
    || session.sourceKind === 'openclaw';
}

function extractUserText(record: CcUserRecord): string {
  const content = record.message.content;
  if (typeof content === 'string') return stripCommandEnvelopeText(content);
  const parts: string[] = [];
  for (const p of content) {
    if (p.type === 'text') parts.push(stripCommandEnvelopeText(p.text));
    if (p.type === 'tool_result' && typeof p.content === 'string') parts.push(p.content);
  }
  return parts.join('\n');
}

// ---------- Segment → ResultEntry ----------

/**
 * SkillSegment[] → ResultEntry[] (omk 内部分析路径的标准输入)。
 *
 * 映射规则(详见 docs/skill-health-spec.md):
 *   - 每 segment 一个 ResultEntry
 *   - sample_id = `${sessionId}:${segmentIndex}`
 *   - variant key = skill 名(复用 omk 的 variant 维度作为 skill 分组维度)
 */
export function segmentsToResultEntries(segments: SkillSegment[]): ResultEntry[] {
  return segments.map((seg): ResultEntry => ({
    sample_id: `${seg.sessionId}:${seg.segmentIndex}`,
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
