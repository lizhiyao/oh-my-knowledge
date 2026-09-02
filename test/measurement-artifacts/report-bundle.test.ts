import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import {
  listMeasurementDerivedPaths,
  listMeasurementReportPaths,
  measurementDerivedDir,
  measurementRecordIdFromReportPath,
  parseMeasurementBundleManifest,
  writeMeasurementReportBundle,
} from '../../src/measurement-artifacts/report-bundle.js';

describe('measurement report bundle', () => {
  it('writes an authoritative report and manifest into one self-contained directory', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'omk-measurement-bundle-'));
    const result = writeMeasurementReportBundle({
      rootDir,
      measurementDomain: 'doctor',
      recordId: 'review-doctor-1',
      reportId: 'doctor-1',
      createdAt: '2026-09-02T00:00:00.000Z',
      report: { kind: 'doctor' },
    });
    assert.deepEqual(JSON.parse(readFileSync(result.reportPath, 'utf8')), { kind: 'doctor' });
    assert.equal(parseMeasurementBundleManifest(
      JSON.parse(readFileSync(result.manifestPath, 'utf8')),
    )?.recordId, 'review-doctor-1');
    assert.equal(measurementDerivedDir(rootDir, 'review-doctor-1'), join(
      rootDir,
      'review-doctor-1',
      'derived',
    ));
    const graphPath = join(result.bundleDir, 'derived', 'graph.json');
    mkdirSync(join(result.bundleDir, 'derived'));
    writeFileSync(graphPath, '{}');
    assert.deepEqual(listMeasurementDerivedPaths(rootDir, 'graph.json'), [graphPath]);
  });

  it('lists v2 bundle reports together with v1 flat reports', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'omk-measurement-list-'));
    const current = writeMeasurementReportBundle({
      rootDir,
      measurementDomain: 'observe-health',
      recordId: 'observe-2',
      reportId: 'observe-2',
      createdAt: '2026-09-02T00:00:00.000Z',
      report: {},
    });
    const legacy = join(rootDir, 'observe-1.report.json');
    writeFileSync(legacy, '{}');
    assert.deepEqual(listMeasurementReportPaths(rootDir), [legacy, current.reportPath].sort());
    assert.equal(measurementRecordIdFromReportPath(legacy), 'observe-1');
    assert.equal(measurementRecordIdFromReportPath(current.reportPath), 'observe-2');
  });

  it('rejects unsafe record ids', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'omk-measurement-unsafe-'));
    assert.throws(() => writeMeasurementReportBundle({
      rootDir,
      measurementDomain: 'doctor',
      recordId: '../outside',
      reportId: 'doctor-1',
      createdAt: '2026-09-02T00:00:00.000Z',
      report: {},
    }), /Invalid measurement record id/);
  });
});
