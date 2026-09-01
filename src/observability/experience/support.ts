import { createHash } from 'node:crypto';
import type { ExperienceTimelineEvent } from '../contracts/experience.js';

export function uniqueTimelineEvents(events: ExperienceTimelineEvent[]): ExperienceTimelineEvent[] {
  const byId = new Map<string, ExperienceTimelineEvent>();
  for (const event of events) {
    byId.set(event.id, event);
  }
  return Array.from(byId.values());
}

export function compareTimelineEvents(a: ExperienceTimelineEvent, b: ExperienceTimelineEvent): number {
  const ta = a.timestamp;
  const tb = b.timestamp;
  // 双方都有非空 timestamp 且不同 → 按时间穿插（主线 + subagent 真实交互序）
  if (ta && tb && ta !== tb) {
    return ta.localeCompare(tb);
  }
  // 同一条物理 trace 内 → 按 messageIndex 派生的 order（跨 trace 比 order 没意义）。
  const samePhysicalTrace = a.traceId && b.traceId
    ? a.traceId === b.traceId
    : a.sourceTrace === b.sourceTrace;
  if (samePhysicalTrace) {
    return a.order - b.order;
  }
  // 跨 trace 且 timestamp 不可比 → 主线优先（避免缺 timestamp 时 subagent 顶到最前）
  const roleRank = (event: ExperienceTimelineEvent): number =>
    event.traceRole === 'main' || event.traceRole === 'standalone' ? 0 : 1;
  const rankDiff = roleRank(a) - roleRank(b);
  if (rankDiff !== 0) return rankDiff;
  // 同 traceRole 且 timestamp 缺失时，用物理 trace 身份提供稳定顺序。
  return (a.traceId ?? a.sourceTrace).localeCompare(b.traceId ?? b.sourceTrace)
    || a.sourceTrace.localeCompare(b.sourceTrace)
    || a.order - b.order;
}

export function snippet(value: unknown, max = 240): string | undefined {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

export function fullText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const normalized = text.trim();
  return normalized || undefined;
}

export function hashParts(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}
