import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { coreRunArtifactDirectoryName } from '../../eval-workflows/artifact-store/index.js';
import { parseDoctorReport } from '../../doctor/report-parser.js';
import { parseSkillHealthReport } from '../../observability/skill-health/report.js';
import {
  MEASUREMENT_BUNDLE_MANIFEST_SCHEMA_VERSION,
  MEASUREMENT_MANIFEST_FILE,
  MEASUREMENT_REPORT_FILE,
  type MeasurementBundleManifest,
  type MeasurementDomain,
} from '../../measurement-artifacts/report-bundle.js';
import {
  isReportFileName,
  reportFileStem,
} from '../../measurement-artifacts/file-names.js';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';
import {
  ensureLayoutMarker,
  globalLayout,
  legacyGlobalLayout,
  legacyProjectLayout,
  projectLayout,
  readLayoutMarker,
  type LegacyOmkLayout,
  type OmkLayout,
} from '../../omk-layout/index.js';

export interface LayoutMigrationAction {
  readonly actionKind: 'move-file' | 'remove-duplicate' | 'write-json';
  readonly source?: string;
  readonly target: string;
  readonly size: number;
  readonly value?: unknown;
}

export interface LayoutMigrationPlan {
  readonly scope: 'project' | 'global';
  readonly root: string;
  readonly actions: readonly LayoutMigrationAction[];
  readonly conflicts: readonly string[];
  readonly skipped: readonly string[];
  readonly legacyRoots: readonly string[];
}

export interface AppliedLayoutMigration {
  readonly movedFiles: number;
  readonly removedDuplicates: number;
  readonly writtenFiles: number;
  readonly migratedBytes: number;
}

function walkFiles(root: string, skipped: string[]): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.push(path);
      else skipped.push(path);
    }
  };
  walk(root);
  return out.sort();
}

function sameFile(left: string, right: string): boolean {
  const leftStat = lstatSync(left);
  const rightStat = lstatSync(right);
  return leftStat.isFile()
    && rightStat.isFile()
    && leftStat.size === rightStat.size
    && readFileSync(left).equals(readFileSync(right));
}

function sameJsonFile(path: string, value: unknown): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(readFileSync(path, 'utf8')), value);
  } catch {
    return false;
  }
}

function addMove(
  actions: LayoutMigrationAction[],
  conflicts: string[],
  source: string,
  target: string,
): void {
  if (source === target || !existsSync(source)) return;
  const size = lstatSync(source).size;
  if (!existsSync(target)) {
    actions.push({ actionKind: 'move-file', source, target, size });
    return;
  }
  if (sameFile(source, target)) {
    actions.push({ actionKind: 'remove-duplicate', source, target, size });
    return;
  }
  conflicts.push(`${source} → ${target}`);
}

function addJson(
  actions: LayoutMigrationAction[],
  conflicts: string[],
  target: string,
  value: unknown,
): void {
  if (!existsSync(target)) {
    actions.push({ actionKind: 'write-json', target, size: 0, value });
    return;
  }
  if (!sameJsonFile(target, value)) conflicts.push(`generated manifest → ${target}`);
}

function addTreeMoves(
  actions: LayoutMigrationAction[],
  conflicts: string[],
  skipped: string[],
  sourceRoot: string,
  targetRoot: string,
): void {
  for (const source of walkFiles(sourceRoot, skipped)) {
    addMove(actions, conflicts, source, join(targetRoot, relative(sourceRoot, source)));
  }
}

function bundleManifest(input: Readonly<{
  measurementDomain: MeasurementDomain;
  recordId: string;
  reportId: string;
  createdAt: string;
}>): MeasurementBundleManifest {
  return {
    schemaVersion: MEASUREMENT_BUNDLE_MANIFEST_SCHEMA_VERSION,
    manifestKind: 'measurement-bundle',
    measurementDomain: input.measurementDomain,
    recordId: input.recordId,
    reportId: input.reportId,
    createdAt: input.createdAt,
    reportFile: MEASUREMENT_REPORT_FILE,
  };
}

function addDoctorMoves(
  actions: LayoutMigrationAction[],
  conflicts: string[],
  skipped: string[],
  legacy: LegacyOmkLayout,
  current: OmkLayout,
): void {
  for (const source of walkFiles(legacy.doctorDir, skipped)) {
    const fileName = source.slice(legacy.doctorDir.length + 1);
    if (fileName.includes('/') || fileName.includes('\\') || !isReportFileName(fileName)) {
      skipped.push(source);
      continue;
    }
    const recordId = reportFileStem(fileName);
    if (recordId === null) continue;
    let report;
    try {
      report = parseDoctorReport(JSON.parse(readFileSync(source, 'utf8')));
    } catch {
      report = null;
    }
    if (report === null) {
      conflicts.push(`invalid doctor report: ${source}`);
      continue;
    }
    const bundleDir = join(current.doctorDir, recordId);
    addMove(actions, conflicts, source, join(bundleDir, MEASUREMENT_REPORT_FILE));
    addJson(actions, conflicts, join(bundleDir, MEASUREMENT_MANIFEST_FILE), bundleManifest({
      measurementDomain: 'doctor',
      recordId,
      reportId: report.id,
      createdAt: report.timestamp,
    }));
  }
}

function addObserveHealthMoves(
  actions: LayoutMigrationAction[],
  conflicts: string[],
  skipped: string[],
  legacy: LegacyOmkLayout,
  current: OmkLayout,
): void {
  for (const source of walkFiles(legacy.observeHealthDir, skipped)) {
    const fileName = source.slice(legacy.observeHealthDir.length + 1);
    if (fileName.includes('/') || fileName.includes('\\') || !isReportFileName(fileName)) {
      skipped.push(source);
      continue;
    }
    const recordId = reportFileStem(fileName);
    if (recordId === null) continue;
    let report;
    try {
      report = parseSkillHealthReport(JSON.parse(readFileSync(source, 'utf8')));
    } catch {
      report = null;
    }
    if (report === null) {
      conflicts.push(`invalid observe health report: ${source}`);
      continue;
    }
    const bundleDir = join(current.observeHealthDir, recordId);
    addMove(actions, conflicts, source, join(bundleDir, MEASUREMENT_REPORT_FILE));
    addJson(actions, conflicts, join(bundleDir, MEASUREMENT_MANIFEST_FILE), bundleManifest({
      measurementDomain: 'observe-health',
      recordId,
      reportId: recordId,
      createdAt: report.meta.generatedAt,
    }));
  }
}

function addObservationInboxMoves(
  actions: LayoutMigrationAction[],
  conflicts: string[],
  skipped: string[],
  legacy: LegacyOmkLayout,
  current: OmkLayout,
): void {
  for (const source of walkFiles(legacy.observeInboxDir, skipped)) {
    const rel = relative(legacy.observeInboxDir, source);
    const segments = rel.split(/[\\/]/u);
    const target = segments.length === 1 && isReportFileName(segments[0]!)
      ? join(current.observeInboxReportsDir, segments[0]!)
      : segments[0] === 'drafts'
        ? join(current.observeDraftsDir, ...segments.slice(1))
        : segments.length === 1 && segments[0] === 'sample-drafts.json'
          ? join(current.observeDraftsDir, segments[0])
          : join(current.observeInboxDir, rel);
    addMove(actions, conflicts, source, target);
  }
}

function addGraphMoves(
  actions: LayoutMigrationAction[],
  conflicts: string[],
  skipped: string[],
  legacyRoot: string,
  current: OmkLayout,
): void {
  const evalGraphs = join(legacyRoot, 'graphs', 'eval');
  for (const source of walkFiles(evalGraphs, skipped)) {
    if (!source.endsWith('.graph.json')) {
      skipped.push(source);
      continue;
    }
    try {
      const graph = JSON.parse(readFileSync(source, 'utf8')) as { source?: { sourceId?: unknown } };
      const runId = graph.source?.sourceId;
      if (typeof runId !== 'string' || runId.length === 0) throw new TypeError();
      addMove(actions, conflicts, source, join(
        current.evalDir,
        coreRunArtifactDirectoryName(runId),
        'derived',
        'graph.json',
      ));
    } catch {
      conflicts.push(`invalid eval graph: ${source}`);
    }
  }

  const doctorGraphs = join(legacyRoot, 'graphs', 'doctor');
  for (const source of walkFiles(doctorGraphs, skipped)) {
    const fileName = source.slice(doctorGraphs.length + 1);
    const suffix = fileName.endsWith('.graph.json')
      ? '.graph.json'
      : fileName.endsWith('.card.md')
        ? '.card.md'
        : null;
    if (suffix === null || fileName.includes('/') || fileName.includes('\\')) {
      skipped.push(source);
      continue;
    }
    const recordId = fileName.slice(0, -suffix.length);
    addMove(actions, conflicts, source, join(
      current.doctorDir,
      recordId,
      'derived',
      suffix === '.graph.json' ? 'graph.json' : 'card.md',
    ));
  }
}

function plan(
  scope: 'project' | 'global',
  current: OmkLayout,
  legacy: LegacyOmkLayout,
  moveMachineState: boolean,
): LayoutMigrationPlan {
  readLayoutMarker(current.root);
  const actions: LayoutMigrationAction[] = [];
  const conflicts: string[] = [];
  const skipped: string[] = [];
  addTreeMoves(actions, conflicts, skipped, legacy.evalDir, current.evalDir);
  addDoctorMoves(actions, conflicts, skipped, legacy, current);
  addObserveHealthMoves(actions, conflicts, skipped, legacy, current);
  addObservationInboxMoves(actions, conflicts, skipped, legacy, current);
  addTreeMoves(actions, conflicts, skipped, legacy.managedDir, current.managedDir);
  addTreeMoves(actions, conflicts, skipped, legacy.jobsDir, current.jobsDir);
  addTreeMoves(actions, conflicts, skipped, legacy.tmpDir, current.tmpDir);
  addGraphMoves(actions, conflicts, skipped, legacy.root, current);
  if (moveMachineState) {
    const machine = scope === 'global' ? current : globalLayout();
    addTreeMoves(actions, conflicts, skipped, legacy.toolsDir, machine.toolsDir);
    addTreeMoves(actions, conflicts, skipped, legacy.tunnelsDir, machine.tunnelsDir);
  }
  const legacyRoots = [
    legacy.evalDir,
    legacy.doctorDir,
    legacy.observeHealthDir,
    legacy.observeInboxDir,
    legacy.managedDir,
    legacy.jobsDir,
    legacy.tmpDir,
    join(legacy.root, 'graphs'),
    ...(moveMachineState ? [legacy.toolsDir, legacy.tunnelsDir] : []),
  ];
  return Object.freeze({
    scope,
    root: current.root,
    actions: Object.freeze(actions),
    conflicts: Object.freeze(conflicts),
    skipped: Object.freeze([...new Set(skipped)]),
    legacyRoots: Object.freeze([...new Set(legacyRoots)]),
  });
}

export function planProjectLayoutMigration(cwd: string = process.cwd()): LayoutMigrationPlan {
  return plan('project', projectLayout(cwd), legacyProjectLayout(cwd), true);
}

export function planGlobalLayoutMigration(root?: string): LayoutMigrationPlan {
  return plan('global', globalLayout(root), legacyGlobalLayout(root), true);
}

function removeEmptyTree(path: string): void {
  if (!existsSync(path) || !lstatSync(path).isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyTree(join(path, entry.name));
  }
  try { rmdirSync(path); } catch { /* retain non-empty or concurrently used directories */ }
}

export function applyLayoutMigration(plan: LayoutMigrationPlan): AppliedLayoutMigration {
  if (plan.conflicts.length > 0) {
    throw new TypeError(`OMK layout migration has ${plan.conflicts.length} conflict(s).`);
  }
  let movedFiles = 0;
  let removedDuplicates = 0;
  let writtenFiles = 0;
  let migratedBytes = 0;
  for (const action of plan.actions.filter((candidate) => candidate.actionKind !== 'write-json')) {
    if (action.source === undefined || !existsSync(action.source)) continue;
    mkdirSync(dirname(action.target), { recursive: true });
    if (action.actionKind === 'remove-duplicate') {
      if (!sameFile(action.source, action.target)) {
        throw new TypeError(`OMK layout migration target changed: ${action.target}`);
      }
      unlinkSync(action.source);
      removedDuplicates++;
    } else {
      if (existsSync(action.target)) {
        throw new TypeError(`OMK layout migration target appeared: ${action.target}`);
      }
      try {
        renameSync(action.source, action.target);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        copyFileSync(action.source, action.target);
        if (!sameFile(action.source, action.target)) {
          throw new TypeError(`OMK layout migration copy verification failed: ${action.target}`);
        }
        unlinkSync(action.source);
      }
      movedFiles++;
    }
    migratedBytes += action.size;
  }
  for (const action of plan.actions.filter((candidate) => candidate.actionKind === 'write-json')) {
    if (existsSync(action.target)) {
      if (!sameJsonFile(action.target, action.value)) {
        throw new TypeError(`OMK layout migration manifest changed: ${action.target}`);
      }
      continue;
    }
    writeJsonFileAtomic(action.target, action.value);
    writtenFiles++;
  }
  for (const root of [...plan.legacyRoots].sort((a, b) => b.length - a.length)) {
    removeEmptyTree(root);
  }
  ensureLayoutMarker(plan.root);
  const globalState = globalLayout().stateDir;
  if (plan.scope === 'project' && plan.actions.some((action) => {
    const rel = relative(globalState, action.target);
    return rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
  })) ensureLayoutMarker(globalLayout().root);
  return Object.freeze({ movedFiles, removedDuplicates, writtenFiles, migratedBytes });
}
