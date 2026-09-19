import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
} from '../../../src/evidence/storage/report-bundle.js';

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
    assert.deepEqual(listMeasurementDerivedPaths(rootDir, 'doctor', 'graph.json'), [graphPath]);
  });

  it('lists only complete self-contained v2 bundles from the requested domain', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'omk-measurement-list-'));
    const current = writeMeasurementReportBundle({
      rootDir,
      measurementDomain: 'observe-health',
      recordId: 'observe-2',
      reportId: 'observe-2',
      createdAt: '2026-09-02T00:00:00.000Z',
      report: {},
    });
    const flat = join(rootDir, 'observe-1.report.json');
    writeFileSync(flat, '{}');
    const incompleteDir = join(rootDir, 'observe-incomplete');
    mkdirSync(incompleteDir);
    writeFileSync(join(incompleteDir, 'report.json'), '{}');
    mkdirSync(join(incompleteDir, 'derived'));
    writeFileSync(join(incompleteDir, 'derived', 'graph.json'), '{}');
    const wrongDomain = writeMeasurementReportBundle({
      rootDir,
      measurementDomain: 'doctor',
      recordId: 'doctor-1',
      reportId: 'doctor-1',
      createdAt: '2026-09-02T00:00:00.000Z',
      report: {},
    });
    assert.deepEqual(
      listMeasurementReportPaths(rootDir, 'observe-health'),
      [current.reportPath],
    );
    assert.deepEqual(listMeasurementReportPaths(rootDir, 'doctor'), [wrongDomain.reportPath]);
    assert.deepEqual(listMeasurementDerivedPaths(rootDir, 'observe-health', 'graph.json'), []);
    assert.equal(measurementRecordIdFromReportPath(flat), null);
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

  it('拒绝空 reportId 与非 RFC3339 时间戳，且不留半截 bundle', () => {
    for (const [label, patch] of [
      ['空 reportId', { reportId: '' }],
      ['非 RFC3339 createdAt', { createdAt: '2026-09-02' }],
    ] as const) {
      const rootDir = mkdtempSync(join(tmpdir(), 'omk-measurement-identity-'));
      assert.throws(() => writeMeasurementReportBundle({
        rootDir,
        measurementDomain: 'doctor',
        recordId: 'review-doctor-1',
        reportId: 'doctor-1',
        createdAt: '2026-09-02T00:00:00.000Z',
        report: { kind: 'doctor' },
        ...patch,
      }), /Invalid measurement bundle identity/, label);
      assert.equal(existsSync(join(rootDir, 'review-doctor-1')), false, `${label}: 校验失败不得留下 bundle 目录`);
      assert.deepEqual(readdirSync(rootDir), [], `${label}: 校验失败不得写入任何产物`);
    }
  });

  it('拒绝穿越式与空派生产物文件名', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'omk-measurement-derived-'));
    for (const fileName of ['graph.json/../../escape', '/abs/graph.json', '', 'a\\b.json']) {
      assert.throws(
        () => listMeasurementDerivedPaths(rootDir, 'doctor', fileName),
        /Invalid derived file name/,
        JSON.stringify(fileName),
      );
    }
  });
});
