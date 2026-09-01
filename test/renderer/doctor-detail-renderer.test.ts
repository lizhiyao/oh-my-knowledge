import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { renderDoctorDetail } from '../../src/renderer/doctor-detail-renderer.js';
import type { DoctorReport } from '../../src/doctor/contracts.js';

const report: DoctorReport = {
  kind: 'doctor',
  schemaVersion: '3.0.0',
  id: 'doctor-20260630T120000-abcd',
  timestamp: '2026-06-30T12:00:00.000Z',
  cliVersion: 'test',
  cwd: '/tmp/project',
  executorName: 'claude',
  model: 'sonnet',
  outcome: 'warnings_only',
  totals: { pass: 0, warn: 1, fail: 0 },
  ruleStats: { pass: 0, warn: 2, fail: 0, skipped: 0, total: 2 },
  skills: [{
    skillName: 'demo',
    skillPath: '/tmp/project/skills/demo/SKILL.md',
    status: 'warn',
    results: [
      {
        ruleId: 'skill_health:a',
        groupId: 'skill_health',
        severity: 'warn',
        labelKey: 'cli.doctor.health.dim.doc-clarity',
        status: 'warn',
        message: '亚健康',
        detail: {
          displayName: 'Documentation clarity',
          findings: [{
            level: '警告',
            description: 'Missing rollback note',
            support: { k: 1, n: 2 },
          }],
        },
        durationMs: 10,
      },
      {
        ruleId: 'skill_health:_summary',
        groupId: 'skill_health',
        severity: 'info',
        labelKey: 'cli.doctor.health.summary.label',
        status: 'warn',
        message: 'parsed only 1/2 samples',
        detail: {
          samples: { requested: 2, succeeded: 1, concurrency: 2, degraded: true },
        },
        durationMs: 10,
      },
    ],
  }],
};

describe('renderDoctorDetail', () => {
  it('renders degraded sampling alert and localized support tooltip in English', () => {
    const html = renderDoctorDetail(report, 'demo', '?lang=en', 'en');

    assert.ok(html.includes('Consensus confidence degraded'));
    assert.ok(html.includes('Only 1/2 samples parsed successfully'));
    assert.ok(html.includes('title="Reported by 1 of 2 samples"'));
    assert.ok(!html.includes('次采样里有'));
  });

  it('renders degraded sampling alert and support tooltip in Chinese', () => {
    const html = renderDoctorDetail(report, 'demo', '', 'zh');

    assert.ok(html.includes('共识置信降级'));
    assert.ok(html.includes('本次只成功解析 1/2 次采样'));
    assert.ok(html.includes('title="2 次采样里有 1 次报了这条"'));
  });
});
