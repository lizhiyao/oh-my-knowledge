import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { doctorGraphDirForDoctorOutput } from '../artifact-graph/doctor.js';
import { buildStudioDiagnosisSummary, mergeDiagnosisBundles } from '../diagnosis/studio-projection.js';
import {
  GRAPH_FILE_SUFFIX,
  isReportFileName,
  reportFileStem,
} from '../measurement-artifacts/file-names.js';
import {
  artifactIndexDir,
  cardTargetSentinel,
  listLiveDoctorCards,
  listLiveObserveCards,
} from '../measurement-artifacts/discovery-index.js';
import { confidenceOf, toolStabilityOf, type SkillHealthReport } from '../observability/skill-health-analyzer.js';
import { DEFAULT_OBSERVATIONS_DIR, loadLatestObservationInboxReports } from '../observability/inbox.js';
import { parseSkillHealthReport } from '../observability/skill-health-report.js';
import { parseArtifactGraphDocument } from '../shared/artifact-graph.js';
import { parseDoctorReport } from '../shared/doctor-report.js';
import { ownRecordValue } from '../shared/record-count.js';
import type {
  Insight,
  SkillDoctorSnapshot,
  SkillGraphSnapshot,
  SkillIndex,
  SkillIndexEntry,
  SkillIndexSummary,
  SkillObserveSnapshot,
} from '../types/index.js';
import type { Diagnosis } from '../diagnosis/contracts.js';
import type { DoctorReport } from '../doctor/contracts.js';
import type { ArtifactGraphDocument, ArtifactGraphNode } from '../artifact-graph/contracts.js';
import { detectInsights } from './skill-insights.js';

export type {
  SkillDoctorSnapshot,
  SkillGraphSnapshot,
  SkillIndex,
  SkillIndexEntry,
  SkillIndexSummary,
  SkillObserveSnapshot,
} from '../types/index.js';

interface SkillIndexCache {
  fingerprint: string;
  result: SkillIndex;
}

let indexCache: SkillIndexCache | null = null;

function directoryFingerprint(directory: string, suffix: string): string {
  try {
    const directoryStat = statSync(directory);
    const files = readdirSync(directory).filter((file) => file.endsWith(suffix)).sort();
    const parts = files.map((file) => {
      try {
        const stat = statSync(join(directory, file));
        return `${file}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${file}:?`;
      }
    });
    return `${directory}:${directoryStat.mtimeMs}:${parts.join(',')}`;
  } catch {
    return `${directory}:missing`;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function cardFingerprint(
  includeObserveCards: boolean,
  includeDoctorCards: boolean,
): string {
  const observe = includeObserveCards
    ? `${directoryFingerprint(artifactIndexDir('observe-health'), '.report.json')}:${cardTargetSentinel('observe-health')}`
    : '';
  const doctor = includeDoctorCards
    ? `${directoryFingerprint(artifactIndexDir('doctor'), '.report.json')}:${cardTargetSentinel('doctor')}`
    : '';
  return `${observe}|${doctor}`;
}

function doctorSnapshot(report: DoctorReport, skillName: string): SkillDoctorSnapshot | null {
  const skill = report.skills.find((candidate) => candidate.skillName === skillName);
  if (skill === undefined) return null;
  return {
    reportId: report.id,
    timestamp: report.timestamp,
    status: skill.status,
    passCount: skill.results.filter((result) => result.status === 'pass').length,
    warnCount: skill.results.filter((result) => result.status === 'warn').length,
    failCount: skill.results.filter((result) => result.status === 'fail').length,
    results: skill.results,
  };
}

function scanDoctorReports(directory: string): Record<string, SkillDoctorSnapshot[]> {
  const bySkill: Record<string, SkillDoctorSnapshot[]> = Object.create(null);
  if (!existsSync(directory)) return bySkill;
  for (const file of readdirSync(directory)) {
    if (!isReportFileName(file)) continue;
    try {
      const report = parseDoctorReport(JSON.parse(readFileSync(join(directory, file), 'utf8')));
      if (report === null) continue;
      for (const skill of report.skills) {
        const snapshot = doctorSnapshot(report, skill.skillName);
        if (snapshot !== null) (bySkill[skill.skillName] ??= []).push(snapshot);
      }
    } catch {
      // Corrupt independent reports do not hide healthy reports.
    }
  }
  return bySkill;
}

function observeSnapshot(
  analysisId: string,
  generatedAt: string,
  health: SkillHealthReport['bySkill'][string],
): SkillObserveSnapshot {
  const resolved = health.toolResolvedCount ?? health.toolCallCount;
  const comparable = Math.max(0, resolved - (health.toolCancelledCount ?? 0));
  const failureRateMeasured = comparable >= 5;
  const gapRate = health.gap?.weightedGapRate ?? 0;
  const healthBand = failureRateMeasured && health.toolFailureRate >= 0.4
    ? 'red'
    : gapRate >= 0.3 || (failureRateMeasured && health.toolFailureRate >= 0.2)
      ? 'yellow'
      : 'green';
  return {
    analysisId,
    generatedAt,
    healthBand,
    failureRate: health.toolFailureRate,
    toolCallCount: health.toolCallCount,
    toolResolvedCount: health.toolResolvedCount,
    toolCancelledCount: health.toolCancelledCount,
    toolUnknownCount: health.toolUnknownCount,
    segmentCount: health.segmentCount,
    gapRate,
    stability: health.toolCallCount === undefined
      ? health.stability
      : toolStabilityOf(health.toolFailureRate, comparable, health.toolCallCount),
    confidence: health.confidence ?? confidenceOf(health.segmentCount),
  };
}

function scanObserveReports(directory: string): Record<string, SkillObserveSnapshot[]> {
  const bySkill: Record<string, SkillObserveSnapshot[]> = Object.create(null);
  if (!existsSync(directory)) return bySkill;
  for (const file of readdirSync(directory)) {
    const id = reportFileStem(file);
    if (id === null) continue;
    try {
      const report = parseSkillHealthReport(JSON.parse(readFileSync(join(directory, file), 'utf8')));
      if (report === null) continue;
      for (const [skillName, health] of Object.entries(report.bySkill)) {
        (bySkill[skillName] ??= []).push(observeSnapshot(id, report.meta.generatedAt, health));
      }
    } catch {
      // Corrupt independent reports do not hide healthy reports.
    }
  }
  return bySkill;
}

function readDoctorGraph(path: string): ArtifactGraphDocument | null {
  try {
    const graph = parseArtifactGraphDocument(JSON.parse(readFileSync(path, 'utf8')));
    return graph?.source.sourceKind === 'doctor' ? graph : null;
  } catch {
    return null;
  }
}

function graphSkillNames(graph: ArtifactGraphDocument): string[] {
  return unique([
    graph.scope.skillName ?? '',
    ...graph.nodes.filter((node) => node.nodeKind === 'skill').map((node) => node.label),
  ]);
}

function nodePreview(node: ArtifactGraphNode) {
  return {
    stableKey: node.stableKey,
    nodeKind: node.nodeKind,
    label: node.label,
    ...(node.status ? { status: node.status } : {}),
  };
}

function doctorGraphForSkill(
  skillName: string,
  reportId: string | undefined,
  graphDirectories: readonly string[],
): SkillGraphSnapshot | undefined {
  const candidates = graphDirectories.flatMap((directory) => {
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((file) => file.endsWith(GRAPH_FILE_SUFFIX))
      .map((file) => ({ path: join(directory, file), graph: readDoctorGraph(join(directory, file)) }))
      .filter((entry): entry is { path: string; graph: ArtifactGraphDocument } => entry.graph !== null)
      .filter(({ graph }) => (!reportId || graph.source.sourceId === reportId) && graphSkillNames(graph).includes(skillName));
  }).sort((a, b) => a.graph.generatedAt.localeCompare(b.graph.generatedAt));
  const latest = candidates.at(-1);
  if (latest === undefined) return undefined;
  const graph = latest.graph;
  const definitionKinds = new Set<ArtifactGraphNode['nodeKind']>([
    'skill_file', 'frontmatter', 'reference', 'script', 'preflight', 'tool',
    'hard_rule', 'workflow', 'workflow_node', 'doctor_rule_result',
  ]);
  const sourceLocator = graph.scope.sourceLocator;
  return {
    bindingStrength: graph.scope.artifactHash
      ? 'content-hash'
      : sourceLocator ? 'source-locator' : 'name-only',
    ...(graph.scope.artifactHash ? { artifactHash: graph.scope.artifactHash } : {}),
    ...(sourceLocator ? { sourceLocator } : {}),
    doctor: {
      sourceKind: 'doctor',
      sourceId: graph.source.sourceId,
      graphId: graph.graphId,
      generatedAt: graph.generatedAt,
      graphPath: latest.path,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      references: graph.nodes.filter((node) => node.nodeKind === 'reference').length,
      scripts: graph.nodes.filter((node) => node.nodeKind === 'script').length,
      workflows: graph.nodes.filter((node) => node.nodeKind === 'workflow').length,
      workflowNodes: graph.nodes.filter((node) => node.nodeKind === 'workflow_node').length,
      hardRules: graph.nodes.filter((node) => node.nodeKind === 'hard_rule').length,
      definitionNodes: graph.nodes.filter((node) => definitionKinds.has(node.nodeKind)).map(nodePreview),
    },
  };
}

function effectiveObserveBand(observe: SkillObserveSnapshot | null): SkillIndexEntry['band'] {
  if (observe === null || observe.confidence === 'underpowered') return 'gray';
  const comparable = Math.max(
    0,
    (observe.toolResolvedCount ?? observe.toolCallCount ?? 0)
      - (observe.toolCancelledCount ?? 0),
  );
  if (observe.healthBand === 'green' && (observe.toolCallCount ?? 0) > 0 && comparable < 5) {
    return 'gray';
  }
  return observe.healthBand;
}

function combinedBand(
  doctor: SkillDoctorSnapshot | null,
  observe: SkillObserveSnapshot | null,
): SkillIndexEntry['band'] {
  const doctorBand = doctor === null ? 'gray' : doctor.status === 'fail' ? 'red' : doctor.status === 'warn' ? 'yellow' : 'green';
  const observeBand = effectiveObserveBand(observe);
  if (doctorBand === 'red' || observeBand === 'red') return 'red';
  if (doctorBand === 'yellow' || observeBand === 'yellow') return 'yellow';
  if (doctorBand === 'green' || observeBand === 'green') return 'green';
  return 'gray';
}

function latestTimestamp(entry: SkillIndexEntry): string {
  return [entry.doctor?.timestamp, entry.observe?.generatedAt].filter(Boolean).sort().at(-1) ?? '';
}

export interface BuildSkillIndexOptions {
  includeObserveCards?: boolean;
  includeDoctorCards?: boolean;
  doctorGraphDirs?: string[];
}

export function _resetSkillIndexCache(): void {
  indexCache = null;
}

export function buildSkillIndex(
  analysesDir: string,
  doctorsDir: string,
  observationsDir: string = DEFAULT_OBSERVATIONS_DIR,
  options: BuildSkillIndexOptions = {},
): SkillIndex {
  const includeObserveCards = options.includeObserveCards ?? false;
  const includeDoctorCards = options.includeDoctorCards ?? false;
  const graphDirectories = unique([
    doctorGraphDirForDoctorOutput(doctorsDir),
    ...(options.doctorGraphDirs ?? []),
  ]);
  const fingerprint = [
    directoryFingerprint(analysesDir, '.report.json'),
    directoryFingerprint(doctorsDir, '.report.json'),
    directoryFingerprint(observationsDir, '.report.json'),
    ...graphDirectories.map((directory) => directoryFingerprint(directory, GRAPH_FILE_SUFFIX)),
    cardFingerprint(includeObserveCards, includeDoctorCards),
  ].join('|');
  if (indexCache?.fingerprint === fingerprint) return indexCache.result;

  const observeBy = scanObserveReports(analysesDir);
  if (includeObserveCards) {
    for (const card of listLiveObserveCards()) {
      try {
        const report = parseSkillHealthReport(JSON.parse(readFileSync(card.path, 'utf8')));
        if (report === null) continue;
        for (const [skillName, health] of Object.entries(report.bySkill)) {
          const list = (observeBy[skillName] ??= []);
          if (!list.some((snapshot) => snapshot.analysisId === card.id)) {
            list.push(observeSnapshot(card.id, report.meta.generatedAt, health));
          }
        }
      } catch {
        // Ignore stale cards.
      }
    }
  }

  const doctorBy = scanDoctorReports(doctorsDir);
  if (includeDoctorCards) {
    for (const card of listLiveDoctorCards()) {
      try {
        const report = parseDoctorReport(JSON.parse(readFileSync(card.path, 'utf8')));
        if (report === null || report.id !== card.reportId) continue;
        const snapshot = doctorSnapshot(report, card.skillName);
        if (snapshot === null) continue;
        const list = (doctorBy[card.skillName] ??= []);
        if (!list.some((candidate) => candidate.reportId === snapshot.reportId)) list.push(snapshot);
      } catch {
        // Ignore stale cards.
      }
    }
  }
  for (const list of Object.values(observeBy)) list.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  for (const list of Object.values(doctorBy)) list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const diagnosisBundle = mergeDiagnosisBundles(
    loadLatestObservationInboxReports(observationsDir).flatMap((report) => report.diagnostics ? [report.diagnostics] : []),
    new Date().toISOString(),
  );
  const allSkills = new Set([
    ...Object.keys(observeBy),
    ...Object.keys(doctorBy),
    ...Object.keys(diagnosisBundle.bySkill),
  ]);
  const entries: SkillIndexEntry[] = [...allSkills].map((skillName) => {
    const doctorHistory = doctorBy[skillName] ?? [];
    const observeHistory = observeBy[skillName] ?? [];
    const doctor = doctorHistory.at(-1) ?? null;
    const observe = observeHistory.at(-1) ?? null;
    return {
      skillName,
      doctor,
      observe,
      doctorHistory,
      observeHistory,
      band: combinedBand(doctor, observe),
    };
  });
  entries.sort((a, b) => latestTimestamp(b).localeCompare(latestTimestamp(a)));

  const insightsBySkill = new Map<string, Insight[]>();
  for (const entry of entries) {
    const insights = detectInsights(entry, {
      diagnostics: ownRecordValue(diagnosisBundle.bySkill, entry.skillName) ?? [],
    });
    insightsBySkill.set(entry.skillName, insights);
    if (entry.band === 'gray') {
      if (insights.some((insight) => insight.severity === 'high')) entry.band = 'red';
      else if (insights.some((insight) => insight.severity === 'medium')) entry.band = 'yellow';
    }
    const graph = doctorGraphForSkill(entry.skillName, entry.doctor?.reportId, graphDirectories);
    if (graph !== undefined) entry.graph = graph;
  }

  const summary: SkillIndexSummary = {
    totalSkills: entries.length,
    withObserve: entries.filter((entry) => entry.observe !== null).length,
    withDoctor: entries.filter((entry) => entry.doctor !== null).length,
    red: entries.filter((entry) => entry.band === 'red').length,
    yellow: entries.filter((entry) => entry.band === 'yellow').length,
    green: entries.filter((entry) => entry.band === 'green').length,
    gray: entries.filter((entry) => entry.band === 'gray').length,
  };
  const diagnosticsBySkill = new Map<string, Diagnosis[]>(Object.entries(diagnosisBundle.bySkill));
  const result: SkillIndex = {
    entries,
    summary,
    insightsBySkill,
    diagnosticsBySkill,
    diagnosisSummary: buildStudioDiagnosisSummary(diagnosisBundle),
  };
  indexCache = { fingerprint, result };
  return result;
}

export function getSkillEntry(index: SkillIndex, skillName: string): SkillIndexEntry | null {
  return index.entries.find((entry) => entry.skillName === skillName) ?? null;
}
