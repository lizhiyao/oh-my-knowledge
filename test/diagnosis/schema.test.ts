import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { buildObserveDiagnostics } from '../../src/diagnosis/observe-mapper.js';
import { parseDiagnosisBundle } from '../../src/diagnosis/contracts/parser.js';

function validBundle() {
  return buildObserveDiagnostics({
    generatedAt: '2026-05-15T00:00:00.000Z',
    problemPatterns: [{
      skillName: 'audit',
      bucket: 'workflow_mismatch',
      patternKey: 'workflow-mismatch:demo',
      signalTypes: ['user_correction'],
      count: 3,
      sessionCount: 2,
      evidenceRefs: [{
        id: 'evidence-1',
        kind: 'message',
        sessionId: 'session-1',
        messageIndex: 3,
        timestamp: '2026-05-14T23:59:00.000Z',
      }],
      lastSeen: '2026-05-15T00:00:00.000Z',
    }],
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('parseDiagnosisBundle', () => {
  it('accepts a source-neutral bundle with aggregated occurrence counts', () => {
    const bundle = validBundle();
    const parsed = parseDiagnosisBundle(bundle);
    assert.ok(parsed);
    assert.equal(parsed.bySkill.audit[0].occurrenceCount, 3);
    assert.equal(parsed.bySkill.audit[0].occurrences.length, 1);
  });

  it('rejects broken cross-object references and duplicate identities', () => {
    const brokenStableKey = clone(validBundle());
    brokenStableKey.bySkill.audit[0].occurrences[0].diagnosisStableKey = 'another-key';
    assert.equal(parseDiagnosisBundle(brokenStableKey), null);

    const brokenSkill = clone(validBundle());
    brokenSkill.bySkill.audit[0].scope.refs.skillName = 'another-skill';
    assert.equal(parseDiagnosisBundle(brokenSkill), null);

    const duplicate = clone(validBundle());
    duplicate.bySkill.audit.push(clone(duplicate.bySkill.audit[0]));
    assert.equal(parseDiagnosisBundle(duplicate), null);
  });

  it('rejects unsupported enums, malformed timestamps, and impossible counts', () => {
    const invalidSource = clone(validBundle()) as unknown as Record<string, unknown>;
    const invalidSourceDiagnosis = (invalidSource.bySkill as Record<string, Array<Record<string, unknown>>>).audit[0];
    (invalidSourceDiagnosis.occurrences as Array<Record<string, unknown>>)[0].source = 'codex';
    assert.equal(parseDiagnosisBundle(invalidSource), null);

    const uncoveredSource = clone(validBundle());
    uncoveredSource.sourceCoverage.observe = false;
    assert.equal(parseDiagnosisBundle(uncoveredSource), null);

    const invalidTimestamp = clone(validBundle());
    invalidTimestamp.generatedAt = 'not-a-timestamp';
    assert.equal(parseDiagnosisBundle(invalidTimestamp), null);

    const impossibleCount = clone(validBundle());
    impossibleCount.bySkill.audit[0].occurrenceCount = 0;
    assert.equal(parseDiagnosisBundle(impossibleCount), null);
  });
});
