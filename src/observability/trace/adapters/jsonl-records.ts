/** Claude / OpenClaw 等 JSONL 适配器共享的记录级判定与映射基元；逐行为 source.ts 内联实现等价搬移。 */

import type { TraceLifecycleEvent, TraceMessageOrigin } from '../trace-ir.js';
import { nonNegativeMetric } from '../../../executors/core/token-usage.js';
import {
  isRuntimeProtocolPromptText,
  isSyntheticUserMessageText,
} from '../message-classification.js';

export function isRecordObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isValidUsageCounters(
  input: unknown,
  output: unknown,
  cacheRead: unknown,
  cacheCreation: unknown,
): boolean {
  return isTokenCounter(input)
    && isTokenCounter(output)
    && (cacheRead === undefined || isTokenCounter(cacheRead))
    && (cacheCreation === undefined || isTokenCounter(cacheCreation));
}

function isTokenCounter(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function lifecycleEventFromLegacy(
  raw: Record<string, unknown>,
  runId: string,
  sourceIndex: number,
  sourceType: string,
  timestamp?: string,
): TraceLifecycleEvent | null {
  const phase = /^session[._-]started$/i.test(sourceType)
    ? 'session_started'
    : /^session[._-]ended$/i.test(sourceType)
      ? 'session_ended'
      : /^turn[._-]started$/i.test(sourceType)
        ? 'turn_started'
        : /^turn[._-](?:ended|completed)$/i.test(sourceType)
          ? 'turn_completed'
          : /^turn[._-]aborted$/i.test(sourceType)
            ? 'turn_aborted'
            : /^turn[._-]interrupted$/i.test(sourceType)
              ? 'turn_interrupted'
              : null;
  if (!phase) return null;
  return {
    eventKind: 'lifecycle',
    eventId: `${runId}:${sourceIndex}:lifecycle`,
    sourceIndex,
    sourceType,
    timestamp,
    turnId: typeof raw.turnId === 'string' ? raw.turnId : undefined,
    phase,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
    durationMs: nonNegativeMetric(raw.durationMs),
  };
}

export function classifyUserMessageOrigin(record: Record<string, unknown>, text: string): TraceMessageOrigin {
  if (record.isMeta === true && typeof record.sourceToolUseID === 'string') return 'skill-context';
  if (/^Base directory for this skill:\s+.+(?:\n| )#\s+[a-z0-9][\w.-]*/i.test(text)) return 'skill-context';
  if (isRuntimeInjectedMessage(text)) return 'runtime';
  if (
    record.entrypoint === 'sdk-ts'
    && typeof record.promptId === 'string'
    && (
      /^进入.+流程。当前页面已经完成本地工作区恢复/.test(text)
      || /gui-workflow route/.test(text)
      || /当前页面已经完成本地工作区恢复/.test(text)
    )
  ) return 'runtime';
  if (isSyntheticUserMessageText(text)) return 'synthetic';
  return 'human';
}

function isRuntimeInjectedMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return /^Conversation info \(untrusted metadata\):\s*```json/i.test(trimmed)
    || isRuntimeProtocolPromptText(trimmed)
    || /^# AGENTS\.md instructions\b/i.test(trimmed)
    || /^<(?:app-context|environment_context|permissions instructions|collaboration_mode|apps_instructions|plugins_instructions|skills_instructions|recommended_plugins)>/i.test(trimmed);
}
