import { createHash } from 'node:crypto';
import type { ObservationInboxItem } from '../contracts/inbox.js';

type ObservationIdentityInput = Pick<
  ObservationInboxItem,
  'skillName' | 'cwd' | 'sourceKind' | 'signalType' | 'signalSubtype' | 'evidence'
>;

export function normalizeObservationKeyInput(value: unknown): string {
  const raw = typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  const trimmed = raw.trim();
  const protocolMatch = trimmed.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i);
  const prefix = protocolMatch?.[1] ?? '';
  const body = protocolMatch?.[2] ?? trimmed;
  return (prefix + body
    .toLowerCase()
    .replace(/^['"`]|['"`]$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/:\d+(:\d+)?\b/g, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, ''));
}

export function observationInboxItemKey(item: ObservationIdentityInput): string {
  const raw = item.signalSubtype === 'bash_probe'
    ? 'bash_probe'
    : item.signalType === 'user_feedback'
      ? item.evidence.markerToken || item.evidence.userFeedbackSnippet || item.signalSubtype
      : item.signalType === 'explicit_marker'
        ? item.evidence.markerToken || item.signalSubtype
        : item.evidence.query || item.evidence.path || item.evidence.assistantSnippet || '';
  return [
    item.sourceKind,
    item.skillName,
    item.cwd ?? '',
    item.signalType,
    item.signalSubtype,
    normalizeObservationKeyInput(raw),
  ].join('\u0000');
}

export function aggregateObservationInboxItemId(item: ObservationIdentityInput): string {
  return createHash('sha256')
    .update(`aggregate\u0000${observationInboxItemKey(item)}`)
    .digest('hex')
    .slice(0, 16);
}
