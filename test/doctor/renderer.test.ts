import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { renderDoctorActionPlanText } from '../../src/doctor/renderer.js';
import type { DoctorReport, DoctorRuleResult } from '../../src/types/index.js';

const result = (idx: number): DoctorRuleResult => ({
  ruleId: `rule-${idx}`,
  severity: 'fatal',
  labelKey: `rule-${idx}`,
  status: 'fail',
  message: `message ${idx}`,
  hint: `hint ${idx}`,
  durationMs: 1,
});

function buildReport(results: DoctorRuleResult[]): DoctorReport {
  return {
    kind: 'doctor',
    schemaVersion: '3.0.0',
    id: 'doctor-test',
    timestamp: '2026-07-04T00:00:00.000Z',
    cliVersion: 'test',
    cwd: '/tmp/project',
    executorName: 'test',
    model: 'test',
    skills: [{
      skillName: 'review',
      skillPath: '/tmp/project/skills/review',
      status: 'fail',
      results,
    }],
    outcome: 'failed',
    totals: { pass: 0, warn: 0, fail: 1 },
    ruleStats: { pass: 0, warn: 0, fail: results.length, skipped: 0, total: results.length },
  };
}

describe('doctor renderer', () => {
  it('truncated action plan points users to rerun doctor for full detail', () => {
    const text = renderDoctorActionPlanText(buildReport(Array.from({ length: 8 }, (_, i) => result(i + 1))), 'zh');
    assert.match(text, /还有 2 项/);
    assert.match(text, /运行 `omk doctor` 查看完整明细/);
    assert.doesNotMatch(text, /上方 doctor 输出/);
  });
});
