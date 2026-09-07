import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ExperienceEvidenceRef } from '../../src/observability/contracts/experience.js';
import { isExperienceEvidenceRef } from '../../src/observability/experience/report-value-guards.js';
import type { ExperienceEvidenceKind } from '../../src/observability/contracts/experience.js';

// Frozen pre-schema structural contract.
interface LegacyExperienceEvidenceRef {
  id: string;
  kind: ExperienceEvidenceKind;
  traceId?: string;
  sourceTrace: string;
  sessionId: string;
  traceRole?: 'standalone' | 'main' | 'subagent';
  traceLabel?: string;
  messageIndex?: number;
  logicalMessageIndex?: number;
  sourceLineIndex?: number;
  messageUuid?: string;
  /** Source-native record classification retained after normalization. */
  sourceType?: string;
  /** Source-neutral identity for one agent turn, when the trace exposes it. */
  turnId?: string;
  /** Source-neutral identity for one concrete tool-call occurrence. */
  callInstanceId?: string;
  toolUseId?: string;
  timestamp?: string;
  role?: 'user' | 'assistant' | 'tool' | 'other';
  modelActivityKind?: 'reasoning';
  contentVisibility?: 'plaintext' | 'opaque';
  contentSource?: 'summary' | 'content' | 'text';
  runtimeKind?: 'session_context' | 'execution_context' | 'settings' | 'goal' | 'context_compaction' | 'usage';
  label?: string;
  snippet?: string;
}

const base = { id: 'ref', kind: 'tool_use', sourceTrace: 'trace', sessionId: 'session' };

describe('Experience evidence structure', () => {
  it('preserves the original structural type', () => {
    expectTypeOf<ExperienceEvidenceRef>().toEqualTypeOf<LegacyExperienceEvidenceRef>();
  });
  it('accepts unknown fields without changing the original object', () => {
    const value = { ...base, extension: { value: 1 } };
    expect(isExperienceEvidenceRef(value)).toBe(true);
    expect(value).toEqual({ ...base, extension: { value: 1 } });
  });
  it.each(['id', 'kind', 'sourceTrace', 'sessionId'])('requires %s', (field) => {
    const value: Record<string, unknown> = { ...base };
    delete value[field];
    expect(isExperienceEvidenceRef(value)).toBe(false);
  });
  it.each(['messageIndex', 'logicalMessageIndex', 'sourceLineIndex'])('preserves %s bounds', (field) => {
    for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
      expect(isExperienceEvidenceRef({ ...base, [field]: value })).toBe(true);
    }
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, '0']) {
      expect(isExperienceEvidenceRef({ ...base, [field]: value })).toBe(false);
    }
  });
  it.each(['kind', 'traceRole', 'modelActivityKind', 'contentVisibility', 'contentSource', 'runtimeKind', 'role'])('rejects unknown %s values', (field) => {
    expect(isExperienceEvidenceRef({ ...base, [field]: '__unknown__' })).toBe(false);
  });
  it('retains timestamp semantic validation', () => {
    expect(isExperienceEvidenceRef({ ...base, timestamp: '2026-09-07T00:00:00Z' })).toBe(true);
    expect(isExperienceEvidenceRef({ ...base, timestamp: 'not-a-date' })).toBe(false);
    expect(isExperienceEvidenceRef({ ...base, timestamp: null })).toBe(false);
  });
});
