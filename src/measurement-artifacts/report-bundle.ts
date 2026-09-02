import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFileAtomic } from '../shared/atomic-json.js';
import { isRfc3339Timestamp } from '../shared/timestamp.js';
import { safeArtifactFileStem } from './file-names.js';

export const MEASUREMENT_BUNDLE_MANIFEST_SCHEMA_VERSION =
  'omk.measurement-bundle-manifest/v1' as const;
export const MEASUREMENT_REPORT_FILE = 'report.json' as const;
export const MEASUREMENT_MANIFEST_FILE = 'manifest.json' as const;
export const MEASUREMENT_DERIVED_DIR = 'derived' as const;

export type MeasurementDomain = 'doctor' | 'observe-health';

export interface MeasurementBundleManifest {
  readonly schemaVersion: typeof MEASUREMENT_BUNDLE_MANIFEST_SCHEMA_VERSION;
  readonly manifestKind: 'measurement-bundle';
  readonly measurementDomain: MeasurementDomain;
  readonly recordId: string;
  readonly reportId: string;
  readonly createdAt: string;
  readonly reportFile: typeof MEASUREMENT_REPORT_FILE;
}

function assertRecordId(id: string): void {
  if (id.length === 0 || safeArtifactFileStem(id) !== id) {
    throw new TypeError('Invalid measurement record id.');
  }
}

export function measurementBundleDir(rootDir: string, recordId: string): string {
  assertRecordId(recordId);
  return join(rootDir, recordId);
}

export function measurementReportPath(rootDir: string, recordId: string): string {
  return join(measurementBundleDir(rootDir, recordId), MEASUREMENT_REPORT_FILE);
}

export function measurementManifestPath(rootDir: string, recordId: string): string {
  return join(measurementBundleDir(rootDir, recordId), MEASUREMENT_MANIFEST_FILE);
}

export function measurementDerivedDir(rootDir: string, recordId: string): string {
  return join(measurementBundleDir(rootDir, recordId), MEASUREMENT_DERIVED_DIR);
}

export function parseMeasurementBundleManifest(
  value: unknown,
): MeasurementBundleManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const manifest = value as Partial<MeasurementBundleManifest>;
  if (manifest.schemaVersion !== MEASUREMENT_BUNDLE_MANIFEST_SCHEMA_VERSION
      || manifest.manifestKind !== 'measurement-bundle'
      || (manifest.measurementDomain !== 'doctor'
        && manifest.measurementDomain !== 'observe-health')
      || typeof manifest.recordId !== 'string'
      || manifest.recordId.length === 0
      || safeArtifactFileStem(manifest.recordId) !== manifest.recordId
      || typeof manifest.reportId !== 'string'
      || manifest.reportId.length === 0
      || typeof manifest.createdAt !== 'string'
      || !isRfc3339Timestamp(manifest.createdAt)
      || manifest.reportFile !== MEASUREMENT_REPORT_FILE) return null;
  return manifest as MeasurementBundleManifest;
}

export function writeMeasurementReportBundle(input: Readonly<{
  rootDir: string;
  measurementDomain: MeasurementDomain;
  recordId: string;
  reportId: string;
  createdAt: string;
  report: unknown;
}>): Readonly<{ bundleDir: string; manifestPath: string; reportPath: string }> {
  assertRecordId(input.recordId);
  if (input.reportId.length === 0 || !isRfc3339Timestamp(input.createdAt)) {
    throw new TypeError('Invalid measurement bundle identity.');
  }
  const bundleDir = measurementBundleDir(input.rootDir, input.recordId);
  const reportPath = join(bundleDir, MEASUREMENT_REPORT_FILE);
  const manifestPath = join(bundleDir, MEASUREMENT_MANIFEST_FILE);
  writeJsonFileAtomic(reportPath, input.report);
  writeJsonFileAtomic(manifestPath, {
    schemaVersion: MEASUREMENT_BUNDLE_MANIFEST_SCHEMA_VERSION,
    manifestKind: 'measurement-bundle',
    measurementDomain: input.measurementDomain,
    recordId: input.recordId,
    reportId: input.reportId,
    createdAt: input.createdAt,
    reportFile: MEASUREMENT_REPORT_FILE,
  } satisfies MeasurementBundleManifest);
  return Object.freeze({ bundleDir, manifestPath, reportPath });
}

function bundleDirectoriesInRoot(
  rootDir: string,
  measurementDomain: MeasurementDomain,
): string[] {
  if (!existsSync(rootDir)) return [];
  const paths: string[] = [];
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || safeArtifactFileStem(entry.name) !== entry.name) continue;
    const manifestPath = join(rootDir, entry.name, MEASUREMENT_MANIFEST_FILE);
    const reportPath = join(rootDir, entry.name, MEASUREMENT_REPORT_FILE);
    if (!existsSync(manifestPath) || !existsSync(reportPath)) continue;
    try {
      const manifest = parseMeasurementBundleManifest(
        JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown,
      );
      if (manifest?.measurementDomain !== measurementDomain
          || manifest.recordId !== entry.name) continue;
      paths.push(join(rootDir, entry.name));
    } catch {
      // Incomplete or corrupt bundles are not published v2 records.
    }
  }
  return paths.sort();
}

/** Lists reports from complete, manifest-validated v2 bundles in one domain. */
export function listMeasurementReportPaths(
  rootDir: string,
  measurementDomain: MeasurementDomain,
): string[] {
  return bundleDirectoriesInRoot(rootDir, measurementDomain)
    .map((bundleDir) => join(bundleDir, MEASUREMENT_REPORT_FILE))
    .filter(existsSync);
}

export function measurementRecordIdFromReportPath(path: string): string | null {
  const parts = path.split(/[\\/]/);
  const fileName = parts.at(-1);
  if (fileName === MEASUREMENT_REPORT_FILE) return parts.at(-2) ?? null;
  return null;
}

function derivedPathsInRoot(
  rootDir: string,
  measurementDomain: MeasurementDomain,
  fileName: string,
): string[] {
  return bundleDirectoriesInRoot(rootDir, measurementDomain)
    .map((bundleDir) => join(bundleDir, MEASUREMENT_DERIVED_DIR, fileName))
    .filter(existsSync)
    .sort();
}

export function listMeasurementDerivedPaths(
  rootDir: string,
  measurementDomain: MeasurementDomain,
  fileName: string,
): string[] {
  if (fileName.includes('/') || fileName.includes('\\') || fileName.length === 0) {
    throw new TypeError('Invalid derived file name.');
  }
  return derivedPathsInRoot(rootDir, measurementDomain, fileName);
}
