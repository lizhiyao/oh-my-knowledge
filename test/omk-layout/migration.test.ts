import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'vitest';
import { coreRunArtifactDirectoryName } from '../../src/eval-workflows/artifact-store/index.js';
import {
  applyLayoutMigration,
  planGlobalLayoutMigration,
  planProjectLayoutMigration,
} from '../../src/cli/lib/layout-migration.js';
import { globalLayout, projectLayout } from '../../src/omk-layout/index.js';

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function doctorReport() {
  return {
    kind: 'doctor',
    schemaVersion: '3.0.0',
    id: 'doctor-test',
    timestamp: '2026-09-02T00:00:00.000Z',
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

function healthReport() {
  return {
    kind: 'observe-health',
    schemaVersion: '1.0.0',
    meta: {
      tracePath: '/tmp/traces',
      kbPath: null,
      sessionCount: 0,
      segmentCount: 0,
      messageCount: 0,
      toolCallCount: 0,
      toolFailureRate: 0,
      timeRange: { from: '', to: '' },
      generatedAt: '2026-09-02T00:00:00.000Z',
    },
    bySkill: {},
    overall: {
      skillCount: 0,
      segmentCount: 0,
      gapRate: 0,
      weightedGapRate: 0,
      healthBand: 'green',
      confidence: 'underpowered',
    },
  };
}

describe('OMK layout migration', () => {
  it('moves every canonical v1 project domain into the v2 structure', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omk-layout-migrate-'));
    const oldRoot = join(cwd, '.omk');
    const layout = projectLayout(cwd);
    const runId = 'legacy-run';
    const runDir = coreRunArtifactDirectoryName(runId);
    writeJson(join(oldRoot, 'reports', runDir, 'manifest.json'), { runId });
    writeJson(join(oldRoot, 'graphs', 'eval', `${runId}.graph.json`), {
      source: { sourceId: runId },
    });
    const legacyDoctorPath = join(oldRoot, 'doctors', 'example-doctor-test.report.json');
    writeJson(legacyDoctorPath, doctorReport());
    const authoritativeDoctorBytes = readFileSync(legacyDoctorPath);
    writeJson(join(oldRoot, 'graphs', 'doctor', 'example-doctor-test.graph.json'), {});
    writeText(join(oldRoot, 'graphs', 'doctor', 'example-doctor-test.card.md'), 'card');
    writeJson(join(oldRoot, 'observe-health', 'health-1.report.json'), healthReport());
    writeJson(join(oldRoot, 'observe-inbox', 'inbox.report.json'), { kind: 'observe-inbox' });
    writeJson(join(oldRoot, 'observe-inbox', 'sample-drafts.json'), { samples: [] });
    writeJson(join(oldRoot, 'managed', '0123456789ab.json'), { recordKind: 'managed-artifact' });
    writeText(join(oldRoot, 'jobs', 'job.txt'), 'job');
    writeText(join(oldRoot, 'tmp', 'tmp.txt'), 'tmp');

    const plan = planProjectLayoutMigration(cwd);
    assert.deepEqual(plan.conflicts, []);
    assert.ok(plan.actions.length > 0);
    const result = applyLayoutMigration(plan);
    assert.ok(result.movedFiles >= 8);

    assert.ok(existsSync(join(layout.evalDir, runDir, 'manifest.json')));
    assert.ok(existsSync(join(layout.evalDir, runDir, 'derived', 'graph.json')));
    assert.ok(existsSync(join(layout.doctorDir, 'example-doctor-test', 'report.json')));
    assert.deepEqual(
      readFileSync(join(layout.doctorDir, 'example-doctor-test', 'report.json')),
      authoritativeDoctorBytes,
    );
    assert.ok(existsSync(join(layout.doctorDir, 'example-doctor-test', 'manifest.json')));
    assert.ok(existsSync(join(layout.doctorDir, 'example-doctor-test', 'derived', 'graph.json')));
    assert.ok(existsSync(join(layout.observeHealthDir, 'health-1', 'report.json')));
    assert.ok(existsSync(join(layout.observeHealthDir, 'health-1', 'manifest.json')));
    assert.ok(existsSync(join(layout.observeInboxReportsDir, 'inbox.report.json')));
    assert.ok(existsSync(join(layout.observeDraftsDir, 'sample-drafts.json')));
    assert.ok(existsSync(join(layout.managedDir, '0123456789ab.json')));
    assert.ok(existsSync(join(layout.jobsDir, 'job.txt')));
    assert.ok(existsSync(join(layout.tmpDir, 'tmp.txt')));
    assert.deepEqual(JSON.parse(readFileSync(layout.markerPath, 'utf8')), { layoutVersion: 2 });

    const second = planProjectLayoutMigration(cwd);
    assert.deepEqual(second.conflicts, []);
    assert.deepEqual(second.actions, []);
    assert.deepEqual(applyLayoutMigration(second), {
      movedFiles: 0,
      removedDuplicates: 0,
      writtenFiles: 0,
      migratedBytes: 0,
    });
  });

  it('preflights target conflicts before moving any source', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omk-layout-conflict-'));
    const source = join(cwd, '.omk', 'reports', 'content', 'a.json');
    const target = join(projectLayout(cwd).evalDir, 'content', 'a.json');
    writeText(source, 'old');
    writeText(target, 'new');
    const plan = planProjectLayoutMigration(cwd);
    assert.equal(plan.conflicts.length, 1);
    assert.throws(() => applyLayoutMigration(plan), /conflict/);
    assert.equal(readFileSync(source, 'utf8'), 'old');
    assert.equal(readFileSync(target, 'utf8'), 'new');
  });

  it('reports malformed legacy reports as conflicts without mutating the tree', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omk-layout-invalid-report-'));
    const source = join(cwd, '.omk', 'doctors', 'invalid.report.json');
    writeText(source, '{');
    const plan = planProjectLayoutMigration(cwd);
    assert.deepEqual(plan.conflicts, [`invalid doctor report: ${source}`]);
    assert.throws(() => applyLayoutMigration(plan), /conflict/);
    assert.equal(readFileSync(source, 'utf8'), '{');
  });

  it('migrates the global tree with the same durable domains', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-layout-global-'));
    writeJson(join(root, 'observe-health', 'health-1.report.json'), healthReport());
    writeText(join(root, 'jobs', 'job.txt'), 'job');
    writeText(join(root, 'tools', 'tool.bin'), 'tool');

    const plan = planGlobalLayoutMigration(root);
    assert.deepEqual(plan.conflicts, []);
    applyLayoutMigration(plan);
    const layout = globalLayout(root);
    assert.ok(existsSync(join(layout.observeHealthDir, 'health-1', 'report.json')));
    assert.ok(existsSync(join(layout.jobsDir, 'job.txt')));
    // Legacy global machine state is moved below state/ just like project-origin machine state.
    assert.ok(existsSync(join(layout.toolsDir, 'tool.bin')));
  });
});
