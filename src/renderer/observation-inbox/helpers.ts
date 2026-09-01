import { e } from '../layout.js';
import type { Lang } from '../../shared/language.js';
import type { ExperienceFeedbackAttribution } from '../../observability/feedback-projection.js';

export function feedbackAttributionRoleLabel(role?: string): string {
  if (role === 'primary_fault') return '主要归因';
  if (role === 'downstream_related') return '下游关联';
  if (role === 'context_only') return '上下文相关';
  return '关联';
}

export function renderFeedbackAttributionLabel(
  attribution: Pick<ExperienceFeedbackAttribution, 'skillName' | 'attributionRole' | 'reasonCode'>,
): string {
  return [
    attribution.skillName ?? '未知',
    feedbackAttributionRoleLabel(attribution.attributionRole),
    attribution.reasonCode,
  ].map((part) => e(part)).join(' · ');
}

export function skillAnchor(skillName: string): string {
  return `skill-${skillName.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'}`;
}

export function experienceSkillAnchor(skillName: string): string {
  return `exp-${skillAnchor(skillName)}`;
}

export function renderJson(value: unknown): string {
  return `<pre style="margin:8px 0 0;padding:10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:6px;white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.45;max-height:520px;overflow:auto;text-align:left">${e(JSON.stringify(value, null, 2))}</pre>`;
}

export function renderField(label: string, value: unknown): string {
  if (value == null || value === '') return '';
  return `<div style="margin:4px 0;text-align:left"><span style="color:var(--text-muted);font-size:11px">${e(label)}</span><div style="font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;text-align:left;color:var(--text-secondary)">${e(String(value))}</div></div>`;
}

export function formatTimestamp(value?: string): string {
  return value ? value.slice(0, 19).replace('T', ' ') : '—';
}

export function truncateText(value: string, max = 28): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

export function formatDuration(durationMs: number | undefined, lang: Lang): string {
  if (!Number.isFinite(durationMs ?? Number.NaN) || durationMs == null) return '';
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds === 0) return '';
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (lang === 'zh') {
    if (days > 0) return `${days}天${hours > 0 ? ` ${hours}小时` : ''}`;
    if (hours > 0) return `${hours}小时${minutes > 0 ? ` ${minutes}分钟` : ''}`;
    if (minutes > 0) return `${minutes}分钟`;
    return `${totalSeconds}秒`;
  }
  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ''}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

export function formatTimeRange(
  start: string | undefined,
  end: string | undefined,
  durationMs: number | undefined,
  lang: Lang,
): string {
  const range = `${formatTimestamp(start)} ~ ${formatTimestamp(end)}`;
  const duration = formatDuration(durationMs, lang);
  return duration ? `${range} · ${duration}` : range;
}

export function renderArtifactVersion(value: string): string {
  if (value === 'unknown') {
    return `<div style="margin:4px 0;text-align:left"><span style="color:var(--text-muted);font-size:11px">artifactVersion</span><div style="font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;color:var(--yellow);font-weight:600;text-align:left">⚠ unknown</div></div>`;
  }
  return renderField('artifactVersion', value);
}
