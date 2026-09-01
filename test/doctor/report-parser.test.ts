import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { parseDoctorReport } from '../../src/doctor/report-parser.js';
import type { DoctorReport } from '../../src/doctor/contracts.js';

function report(): DoctorReport {
  return {
    kind: 'doctor',
    schemaVersion: '3.0.0',
    id: 'doctor-test',
    timestamp: '2026-07-27T00:00:00.000Z',
    cliVersion: 'test',
    cwd: '/tmp',
    executorName: 'codex',
    model: 'test-model',
    skills: [{
      skillName: 'example',
      skillPath: '/tmp/example/SKILL.md',
      status: 'warn',
      results: [{
        ruleId: 'description',
        severity: 'warn',
        labelKey: 'doctor.description',
        status: 'fail',
        message: 'needs work',
        durationMs: 1,
      }],
    }],
    outcome: 'warnings_only',
    totals: { pass: 0, warn: 1, fail: 0 },
    ruleStats: { pass: 0, warn: 0, fail: 1, skipped: 0, total: 1 },
  };
}

describe('parseDoctorReport', () => {
  it('accepts a structurally and derivationally consistent report', () => {
    assert.deepEqual(parseDoctorReport(report()), report());
  });

  it('rejects forged rollups and impossible skill status', () => {
    const forgedTotals = structuredClone(report());
    forgedTotals.totals.warn = 0;
    assert.equal(parseDoctorReport(forgedTotals), null);

    const forgedStatus = structuredClone(report());
    forgedStatus.skills[0].status = 'pass';
    assert.equal(parseDoctorReport(forgedStatus), null);
  });

  it('rejects malformed timestamps and unsafe counters', () => {
    const malformedTime = structuredClone(report());
    malformedTime.timestamp = 'yesterday';
    assert.equal(parseDoctorReport(malformedTime), null);

    const unsafe = structuredClone(report());
    unsafe.ruleStats.total = Number.MAX_SAFE_INTEGER + 1;
    assert.equal(parseDoctorReport(unsafe), null);
  });
});
