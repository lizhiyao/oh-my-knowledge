import { formatDuration } from '../../display/format.js';

export function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 两次事件之间的时长。缺时间戳或时钟倒挂返回空串：调用方据此省略整段文案，不编造耗时。 */
export function durationBetween(start: string | undefined, end: string | undefined): string {
  const startMs = parseTimestamp(start);
  const endMs = parseTimestamp(end);
  if (startMs === undefined || endMs === undefined || endMs < startMs) return '';
  return formatDuration(endMs - startMs);
}

/** 相对会话起点的时刻（`mm:ss.t`）：密集时间轴上的刻度读数，绝对时刻走 `displayTime`。 */
export function relativeClock(value: string | undefined, start: string | undefined): string {
  const valueMs = parseTimestamp(value);
  const startMs = parseTimestamp(start);
  if (valueMs === undefined || startMs === undefined) return '—';
  return formatRelativeTime(Math.max(0, valueMs - startMs));
}

function formatRelativeTime(milliseconds: number): string {
  const totalTenths = Math.max(0, Math.round(milliseconds / 100));
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

export function shortHash(value: string | undefined): string {
  return value ? value.slice(0, 12) : '—';
}
