import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildStudioDiagnosisSummary, mergeDiagnosisBundles } from '../../diagnosis/studio-projection.js';
import {
  listMeasurementDerivedPaths,
  listMeasurementReportPaths,
  measurementRecordIdFromReportPath,
} from '../../evidence/storage/report-bundle.js';
import {
  artifactIndexDir,
  cardTargetSentinel,
  listLiveDoctorCards,
  listLiveObserveCards,
} from '../../evidence/storage/discovery-index.js';
import { confidenceOf, effectiveObserveBand, toolStabilityOf, type SkillHealthReport } from '../../observability/skill-health/analyzer.js';
import { DEFAULT_OBSERVATIONS_DIR, loadLatestObservationInboxReports } from '../../observability/inbox/index.js';
import { observationReportsDir, resolveObservationsDir } from '../../observability/inbox/paths.js';
import { parseSkillHealthReport } from '../../observability/skill-health/report.js';
import { parseArtifactGraphDocument } from '../../evidence/graph/schema.js';
import { parseDoctorReport } from '../../knowledge-artifacts/doctor/report-parser.js';
import { ownRecordValue } from '../../shared/record-count.js';
import type {
  Insight,
  SkillDoctorSnapshot,
  SkillGraphSnapshot,
  SkillIndex,
  SkillIndexEntry,
  SkillIndexSummary,
  SkillObserveSnapshot,
} from '../view-models/index.js';
import type { Diagnosis } from '../../diagnosis/contracts.js';
import type { DoctorReport } from '../../knowledge-artifacts/doctor/contracts.js';
import type { ArtifactGraphDocument, ArtifactGraphNode } from '../../evidence/graph/contracts.js';
import { assessHealth } from './skill-health.js';
import { detectInsights } from './skill-insights.js';

export type {
  SkillDoctorSnapshot,
  SkillGraphSnapshot,
  SkillIndex,
  SkillIndexEntry,
  SkillIndexSummary,
  SkillObserveSnapshot,
} from '../view-models/index.js';

export interface SkillIndexCacheEntry {
  readonly fingerprint: string;
  readonly result: SkillIndex;
}

/**
 * 有界 keyed 缓存契约。key 是目录组合身份（指纹仍逐次请求重算），
 * 实现必须保证容量上限与淘汰策略，禁止无界 Map<fingerprint, entry>。
 */
export interface SkillIndexCache {
  get(key: string): SkillIndexCacheEntry | undefined;
  set(key: string, entry: SkillIndexCacheEntry): void;
  clear(): void;
}

// 目录组合域实际很小：project↔global 回退翻转 × 固定的 card flags，
// 8 个槽位足以容纳真实翻转与测试注入，超出部分 LRU 淘汰。
const SKILL_INDEX_CACHE_DEFAULT_CAPACITY = 8;

/** LRU 实现：Map 插入序即新旧顺序，命中即提升为最新，写满淘汰最旧。 */
export function createSkillIndexCache(maxEntries = SKILL_INDEX_CACHE_DEFAULT_CAPACITY): SkillIndexCache {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('skill index cache capacity must be a positive integer');
  }
  const entries = new Map<string, SkillIndexCacheEntry>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    set(key, entry) {
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    clear() {
      entries.clear();
    },
  };
}

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

function pathsFingerprint(paths: readonly string[]): string {
  return paths.map((path) => {
    try {
      const stat = statSync(path);
      return `${path}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return `${path}:?`;
    }
  }).sort().join(',');
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
  const seenRecords = new Set<string>();
  for (const path of listMeasurementReportPaths(directory, 'doctor')) {
    const recordId = measurementRecordIdFromReportPath(path);
    if (recordId === null || seenRecords.has(recordId)) continue;
    try {
      const report = parseDoctorReport(JSON.parse(readFileSync(path, 'utf8')));
      if (report === null) continue;
      seenRecords.add(recordId);
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
  const snapshot: Omit<SkillObserveSnapshot, 'effectiveBand'> = {
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
  return { ...snapshot, effectiveBand: effectiveObserveBand(snapshot) };
}

function scanObserveReports(directory: string): Record<string, SkillObserveSnapshot[]> {
  const bySkill: Record<string, SkillObserveSnapshot[]> = Object.create(null);
  const seenRecords = new Set<string>();
  for (const path of listMeasurementReportPaths(directory, 'observe-health')) {
    const id = measurementRecordIdFromReportPath(path);
    if (id === null || seenRecords.has(id)) continue;
    try {
      const report = parseSkillHealthReport(JSON.parse(readFileSync(path, 'utf8')));
      if (report === null) continue;
      seenRecords.add(id);
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
  graphPaths: readonly string[],
): SkillGraphSnapshot | undefined {
  const candidates = graphPaths
      .map((path) => ({ path, graph: readDoctorGraph(path) }))
      .filter((entry): entry is { path: string; graph: ArtifactGraphDocument } => entry.graph !== null)
      .filter(({ graph }) => (!reportId || graph.source.sourceId === reportId) && graphSkillNames(graph).includes(skillName))
      .sort((a, b) => a.graph.generatedAt.localeCompare(b.graph.generatedAt));
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

function latestTimestamp(entry: SkillIndexEntry): string {
  return [entry.doctor?.timestamp, entry.observe?.generatedAt].filter(Boolean).sort().at(-1) ?? '';
}

export interface BuildSkillIndexOptions {
  includeObserveCards?: boolean;
  includeDoctorCards?: boolean;
  /** Owned by the querying server; omitted for uncached standalone builds. */
  cache?: SkillIndexCache;
}

export function buildSkillIndex(
  analysesDir: string,
  doctorsDir: string,
  observationsDir: string = DEFAULT_OBSERVATIONS_DIR,
  options: BuildSkillIndexOptions = {},
): SkillIndex {
  const includeObserveCards = options.includeObserveCards ?? false;
  const includeDoctorCards = options.includeDoctorCards ?? false;
  const graphPaths = listMeasurementDerivedPaths(doctorsDir, 'doctor', 'graph.json');
  const doctorReportPaths = listMeasurementReportPaths(doctorsDir, 'doctor');
  const observeReportPaths = listMeasurementReportPaths(analysesDir, 'observe-health');
  // key 限定目录组合身份，fingerprint 每次请求按文件元数据重算，
  // 保证编辑与删除对缓存可见（目录 mtime 单独不足以检测既有文件的内容变化）。
  const cacheKey = [
    analysesDir, doctorsDir, observationsDir,
    includeObserveCards ? 'observe-cards' : '',
    includeDoctorCards ? 'doctor-cards' : '',
  ].join('\n');
  const fingerprint = options.cache ? [
    analysesDir, doctorsDir, observationsDir,
    pathsFingerprint(observeReportPaths),
    pathsFingerprint(doctorReportPaths),
    directoryFingerprint(observationReportsDir(resolveObservationsDir(observationsDir)), '.report.json'),
    pathsFingerprint(graphPaths),
    cardFingerprint(includeObserveCards, includeDoctorCards),
  ].join('|') : '';
  const cached = options.cache?.get(cacheKey);
  if (cached?.fingerprint === fingerprint) return structuredClone(cached.result);

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
      band: 'gray',
    };
  });
  entries.sort((a, b) => latestTimestamp(b).localeCompare(latestTimestamp(a)));

  const insightsBySkill = new Map<string, Insight[]>();
  for (const entry of entries) {
    const insights = detectInsights(entry, {
      diagnostics: ownRecordValue(diagnosisBundle.bySkill, entry.skillName) ?? [],
    });
    insightsBySkill.set(entry.skillName, insights);
    entry.band = assessHealth(entry, insights, 'zh').color;
    const graph = doctorGraphForSkill(entry.skillName, entry.doctor?.reportId, graphPaths);
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
  if (options.cache) options.cache.set(cacheKey, { fingerprint, result: structuredClone(result) });
  return result;
}
