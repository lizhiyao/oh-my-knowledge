import type { Lang } from '../../../shared/language.js';

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

export function durationBetween(start: string | undefined, end: string | undefined, lang: Lang): string {
  const startMs = parseTimestamp(start);
  const endMs = parseTimestamp(end);
  if (startMs === undefined || endMs === undefined || endMs < startMs) return '';
  return formatElapsed(endMs - startMs, lang);
}

export function formatRelativeTimestamp(value: string | undefined, start: string | undefined): string {
  const valueMs = parseTimestamp(value);
  const startMs = parseTimestamp(start);
  if (valueMs === undefined || startMs === undefined) return '—';
  return formatRelativeTime(Math.max(0, valueMs - startMs));
}

export function formatRelativeTime(milliseconds: number): string {
  const totalTenths = Math.max(0, Math.round(milliseconds / 100));
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

export function formatDisplayTimestamp(value: string | undefined, lang: Lang): string {
  if (!value) return lang === 'zh' ? '时间未知' : 'Time unknown';
  return value.slice(0, 19).replace('T', ' ');
}

export function formatElapsed(milliseconds: number, lang: Lang): string {
  const seconds = Math.max(0, milliseconds / 1000);
  if (seconds < 60) {
    const value = Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1);
    return lang === 'zh' ? `${value} 秒` : `${value}s`;
  }
  const roundedSeconds = Math.round(seconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const remainingSeconds = roundedSeconds % 60;
  return lang === 'zh' ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes}m ${remainingSeconds}s`;
}

export function shortHash(value: string | undefined): string {
  return value ? value.slice(0, 12) : '—';
}
