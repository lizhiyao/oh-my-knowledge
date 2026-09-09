import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { computeSkillHealthFromSegments } from '../../../src/observability/skill-health/analyzer.js';
import { writeMeasurementReportBundle } from '../../../src/evidence/storage/report-bundle.js';
import { querySkillDiff, querySkillTrend } from '../../../src/studio/application/knowledge-reports.js';
import type { SkillSegment } from '../../../src/observability/trace/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function report(root: string, id: string, skillName?: string): void {
  const segments: SkillSegment[] = skillName === undefined ? [] : [{
    skillName, sessionId: 'session', segmentIndex: 0,
    startTimestamp: '2026-09-01T00:00:00Z', endTimestamp: '2026-09-01T00:00:00Z',
    turns: [], toolCalls: [],
    metrics: { durationMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 0, numToolCalls: 0, numToolFailures: 0, numToolUnknown: 0, tokenUsageObserved: false },
  }];
  const data = computeSkillHealthFromSegments(segments, [], join(root, 'trace'));
  writeMeasurementReportBundle({ rootDir: root, recordId: id, reportId: id, measurementDomain: 'observe-health', createdAt: data.meta.generatedAt, report: data });
}

describe('knowledge report identity boundaries', () => {
  it('does not treat inherited properties as skills, but keeps own prototype-like names', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-query-')); roots.push(root);
    report(root, 'empty');
    for (const name of ['constructor', 'toString', '__proto__']) assert.deepEqual(querySkillTrend(root, name).points, []);
    for (const [index, name] of ['constructor', 'toString', '__proto__'].entries()) {
      const id = `named-${index}`;
      report(root, id, name);
      assert.equal(querySkillTrend(root, name).points.length, 1);
      assert.equal(querySkillDiff(root, 'empty', id)?.rows[0].presence, 'only-to');
      assert.equal(querySkillDiff(root, id, 'empty')?.rows[0].presence, 'only-from');
    }
  });
});
