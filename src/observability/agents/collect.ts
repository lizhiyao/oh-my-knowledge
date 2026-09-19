/**
 * 本机 Agent 日志采集：把已支持格式的会话文件投影成归一化 Trace IR 产物。
 *
 * 边界（与 observability 领域规则一致）：
 * - 原始日志是证据。本模块只读用户文件，绝不移动、重命名、截断或删除；归一化产物写进
 *   OMK 自己的 `observe/agents/traces/<agentId>/`，并在报告里保留绝对 `sourcePath` 供回溯。
 * - 增量口径：`mtime + size` 未变且产物仍在 → 跳过；mtime 变了但 sha256 相同 → 沿用产物、
 *   只刷新索引里的时间戳。因此第二次运行同一批日志应该采集 0 个新文件。
 * - 容量与失败都不中断运行：命中上限、解析失败、格式不支持都进 `limitations[]`，
 *   计数按「已处理」口径如实记录，`discovered` 允许大于 `collected + skipped + failed`。
 * - 采集阶段走真实 fs：既有 trace 解析器 `loadTraceCorpus()` 只接受路径，注入假端口会让
 *   发现阶段与解析阶段看到两个不同的世界。用例因此使用显式临时目录。
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { globalLayout } from '../../evidence/storage/layout.js';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { TraceSourceKindSchema } from '../../executors/contracts/trace-source-schema.js';
import { loadTraceCorpus } from '../trace/source.js';
import {
  countUnknownEventDispositions,
  UNKNOWN_DISPOSITION_RULES_VERSION,
} from '../trace/unknown-disposition.js';
import type { TraceSession, TraceSourceKind } from '../trace/trace-ir.js';
import {
  AGENT_COLLECTION_VERSION,
  AgentCollectionReportSchema,
  AgentInventoryReportSchema,
  SUPERSEDED_AGENT_COLLECTION_VERSIONS,
  type AgentCollectionEntry,
  type AgentCollectionReport,
  type AgentDescriptor,
  type AgentInventoryReport,
  type CollectedSession,
} from './contracts.js';
import { detectAgentInventory, type DetectAgentInventoryOptions } from './detect.js';
import { findAgentDescriptor, KNOWN_AGENTS } from './registry.js';
import {
  DEFAULT_MAX_DIRECTORIES_PER_ROOT,
  DEFAULT_MAX_SESSION_FILES_PER_ROOT,
  scanAgentLogRoot,
  type ScannedSessionFile,
} from './scan.js';

export const COLLECTION_REPORT_FILE_NAME = 'collection.json';
/**
 * v2 起产物里的 Trace IR 多了「观测到的效果」这一档事件、工具结果的执行属性（退出码／时长）、
 * 以及跨视图的原生身份位（`sourceIds`／`recordFamily`／`recordId`）。旧产物仍可读，只是不含
 * 这些证据；新产物一律按 v2 声明。
 */
export const AGENT_TRACE_ARTIFACT_VERSION = 'agent-trace-v2' as const;

/**
 * 单轮默认上限：本机日志体量在 GiB 级、共 2.4k+ 文件，首轮只摄取最近的若干个文件。
 * 单文件上限仍是内存边界：峰值约等于 1.2 倍最大可采文件、最坏按 1.27 倍留余量（本机最大的那份
 * 1.4 GB 日志，格式判定合并成单遍之后真机 11 次跑的中位是 1 613～1 648 MiB、最坏 1 712 MiB；
 * 合并前是 1 509～1 513／最坏 1 717 MiB——少掉那几趟多余扫描会抬高高水位，机制见
 * `streamed-records.ts` 头注）。抬高它既抬高可采的最大文件，也按比例抬高内存天花板；
 * 要把峰值稳在某个界限内，就按这个系数反推上限。
 * 字节预算与单文件上限同级，避免一份大文件独占整轮、把其余待采文件挤到下一轮；文件数仍是主限制。
 */
export const DEFAULT_MAX_SESSION_FILES_PER_RUN = 200;
export const DEFAULT_MAX_BYTES_PER_RUN = 2 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_SESSION_FILE_BYTES = 2 * 1024 * 1024 * 1024;
/** 内容摘要的读取块大小：与 trace 读取层一致，避免为大文件保留全文 Buffer。 */
const TRACE_DIGEST_CHUNK_BYTES = 1024 * 1024;
const MAX_ENUMERATED_PATHS = 5;

/** 只声明采集真正需要的三个产物路径，避免与具体 layout 工厂耦合。 */
export interface AgentStorageLayout {
  readonly observeAgentsDir: string;
  readonly observeAgentsInventoryPath: string;
  readonly observeAgentsTracesDir: string;
}

export interface AgentCollectionLimits {
  /** 单个日志根的文件与目录扫描上限（与 detect 同一口径）。 */
  maxSessionFilesPerRoot: number;
  maxDirectoriesPerRoot: number;
  /** 本轮「读内容 + 解析 + 写产物」的文件数与字节数上限。 */
  maxFilesPerRun: number;
  maxBytesPerRun: number;
  /** 单个会话文件的字节上限；超过则本轮不处理，避免一次读入超大文件。 */
  maxFileBytes: number;
}

export interface CollectAgentLogsOptions {
  layout?: AgentStorageLayout;
  limits?: Partial<AgentCollectionLimits>;
  /**
   * 未传入清单时用于现场探测的选项。
   * 其中 `descriptors` 同时决定根查找用哪份登记表：默认内置表，含本机扩展条目时传 `resolveAgentCatalog()` 的结果。
   */
  detect?: DetectAgentInventoryOptions;
  now?: () => string;
  /** 默认 true；false 时只计算不写盘（预览／自检用）。 */
  persist?: boolean;
}

/** 归一化会话产物的信封：保留 provenance，不把派生视图混进原始证据。 */
export interface AgentTraceArtifact {
  schemaVersion: typeof AGENT_TRACE_ARTIFACT_VERSION;
  agentId: string;
  rootId: string;
  sourceKind: TraceSourceKind;
  sourcePath: string;
  collectedAt: string;
  contentDigest: string;
  session: TraceSession;
}

interface RootWork {
  agentId: string;
  displayName: string;
  rootId: string;
  path: string;
  declaredKind: TraceSourceKind;
  files: ScannedSessionFile[];
  readable: boolean;
  truncated: boolean;
  collectedFiles: number;
  skippedFiles: number;
  failedFiles: number;
}

interface Candidate {
  work: RootWork;
  file: ScannedSessionFile;
}

export function collectAgentLogs(
  report?: AgentInventoryReport,
  options: CollectAgentLogsOptions = {},
): AgentCollectionReport {
  const layout = options.layout ?? globalLayout();
  const limits: AgentCollectionLimits = {
    maxSessionFilesPerRoot: positive(
      options.limits?.maxSessionFilesPerRoot,
      DEFAULT_MAX_SESSION_FILES_PER_ROOT,
    ),
    maxDirectoriesPerRoot: positive(
      options.limits?.maxDirectoriesPerRoot,
      DEFAULT_MAX_DIRECTORIES_PER_ROOT,
    ),
    maxFilesPerRun: positive(options.limits?.maxFilesPerRun, DEFAULT_MAX_SESSION_FILES_PER_RUN),
    maxBytesPerRun: positive(options.limits?.maxBytesPerRun, DEFAULT_MAX_BYTES_PER_RUN),
    maxFileBytes: positive(options.limits?.maxFileBytes, DEFAULT_MAX_SESSION_FILE_BYTES),
  };
  const now = options.now ?? (() => new Date().toISOString());
  const collectedAt = now();
  // 探测与根查找共用同一份登记表：两阶段各拿一份表时，只在扩展文件里声明的宿主会被当成未登记。
  const catalog = options.detect?.descriptors ?? KNOWN_AGENTS;
  const inventory = report ?? detectAgentInventory({ ...options.detect, descriptors: catalog });
  const persist = options.persist !== false;
  const limitations: string[] = [];

  const { index: previous, invalid, outdatedVersion } = readPreviousCollection(layout);
  if (invalid) {
    limitations.push('上一次的 collection.json 无法解析，本轮按全量重新采集。');
  } else if (outdatedVersion !== undefined) {
    limitations.push(`上一轮报告是 ${outdatedVersion} 口径，未识别事件的计数无法沿用，本轮按全量重新采集。`);
  }

  const { works, unreadableRoots, truncatedRoots, missingCatalogAgents, missingCatalogRoots, rootlessAgents }
    = discoverRoots(inventory, catalog, limits);
  if (unreadableRoots > 0) {
    limitations.push(`${unreadableRoots} 个日志根存在但无法完整扫描（权限不足或读取失败），其会话计数按 0 记录，未计入本轮采集。`);
  }
  if (truncatedRoots > 0) {
    limitations.push(`${truncatedRoots} 个日志根命中单根扫描上限（每根最多 ${limits.maxSessionFilesPerRoot} 个文件），报告里的计数是截断结果，不是全量。`);
  }
  if (missingCatalogAgents > 0) {
    limitations.push(`${missingCatalogAgents} 个 Agent 不在当前登记表内，其日志根本轮未采集。`);
  }
  if (missingCatalogRoots > 0) {
    limitations.push(`${missingCatalogRoots} 个日志根不在当前登记表内，本轮跳过。`);
  }
  if (rootlessAgents.length > 0) {
    limitations.push(`${rootlessAgents.length} 个已安装 Agent 没有 OMK 已支持的日志根，本轮仅登记安装事实：${rootlessAgents.join('、')}。`);
  }

  const sessions: CollectedSession[] = [];
  const writtenArtifacts = new Set<string>();
  const reusedEntries = new Set<string>();
  const parseFailures: string[] = [];
  const emptySessions: string[] = [];
  const readFailures: string[] = [];
  let unknownFormatSessions = 0;
  let mismatchedFormatSessions = 0;
  let duplicateArtifacts = 0;
  let deferredByCapacity = 0;
  let oversizedFiles = 0;
  let budgetFiles = 0;
  let budgetBytes = 0;

  // 最新优先：容量受限的轮次先拿到最近的证据，更早的文件由后续增量运行补齐。
  const candidates = works.flatMap((work) => work.files.map((file) => ({ work, file })))
    .sort((a, b) => b.file.modifiedAt.localeCompare(a.file.modifiedAt)
      || a.file.path.localeCompare(b.file.path));

  for (const candidate of candidates) {
    const { work, file } = candidate;
    const previousEntry = previous.get(file.path);
    if (previousEntry !== undefined && artifactStillPresent(layout, previousEntry)) {
      if (
        previousEntry.modifiedAt === file.modifiedAt
        && previousEntry.sizeBytes === file.sizeBytes
      ) {
        work.skippedFiles += 1;
        reusedEntries.add(file.path);
        sessions.push(previousEntry);
        continue;
      }
      // mtime 变了但内容没变：产物仍然有效，只刷新索引时间戳，避免每轮重新解析。
      const digest = digestFile(file.path);
      if (digest !== undefined && digest === previousEntry.contentDigest) {
        work.skippedFiles += 1;
        reusedEntries.add(file.path);
        sessions.push({ ...previousEntry, sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt });
        continue;
      }
    }
    if (file.sizeBytes > limits.maxFileBytes) {
      oversizedFiles += 1;
      continue;
    }
    if (budgetFiles >= limits.maxFilesPerRun || budgetBytes >= limits.maxBytesPerRun) {
      deferredByCapacity += 1;
      continue;
    }
    budgetFiles += 1;
    budgetBytes += file.sizeBytes;

    const result = collectOneFile({
      candidate,
      layout,
      collectedAt,
      persist,
      writtenArtifacts,
      parseFailures,
      emptySessions,
      readFailures,
    });
    if (result.sessions.length === 0) continue;
    reusedEntries.add(file.path);
    for (const entry of result.sessions) {
      if (entry.sourceKind === 'unknown') unknownFormatSessions += 1;
      else if (entry.sourceKind !== work.declaredKind) mismatchedFormatSessions += 1;
      sessions.push(entry);
    }
    duplicateArtifacts += result.duplicates;
    work.collectedFiles += 1;
  }

  if (deferredByCapacity > 0) {
    limitations.push(`本轮采集上限为 ${limits.maxFilesPerRun} 个会话文件、${formatBytes(limits.maxBytesPerRun)}，剩余 ${deferredByCapacity} 个待采文件留到后续增量运行。`);
  }
  if (oversizedFiles > 0) {
    limitations.push(`${oversizedFiles} 个会话文件超过单文件上限 ${formatBytes(limits.maxFileBytes)}，本轮未采集。`);
  }
  if (readFailures.length > 0) {
    limitations.push(`${readFailures.length} 个会话文件无法读取：${enumerate(readFailures)}。`);
  }
  if (parseFailures.length > 0) {
    limitations.push(`${parseFailures.length} 个会话文件解析失败：${enumerate(parseFailures)}。`);
  }
  if (emptySessions.length > 0) {
    limitations.push(`${emptySessions.length} 个会话文件解析后没有产生任何会话，通常是记录被适配器过滤或格式不受支持：${enumerate(emptySessions)}。`);
  }
  if (unknownFormatSessions > 0) {
    limitations.push(`${unknownFormatSessions} 个会话按 unknown 格式归档，OMK 尚未支持其原生日志结构。`);
  }
  if (mismatchedFormatSessions > 0) {
    limitations.push(`${mismatchedFormatSessions} 个会话的实际解析格式与日志根登记格式不一致，报告按实际解析结果记录 sourceKind。`);
  }
  if (duplicateArtifacts > 0) {
    limitations.push(`${duplicateArtifacts} 个会话映射到同一 traceId 产物路径，保留先写入者，未覆盖已有产物。`);
  }
  const droppedEntries = previous.size - reusedEntries.size;
  if (droppedEntries > 0) {
    limitations.push(`${droppedEntries} 个历史条目对应的原始日志已不在本轮扫描结果里，已从索引移除；已产出的归一化产物不删除。`);
  }

  const orderedSessions = sessions.sort((a, b) => compareSessionOrder(a, b));
  const collectionReport = AgentCollectionReportSchema.parse({
    schemaVersion: AGENT_COLLECTION_VERSION,
    unknownDispositionRulesVersion: UNKNOWN_DISPOSITION_RULES_VERSION,
    generatedAt: collectedAt,
    outputDir: layout.observeAgentsDir,
    inventoryGeneratedAt: inventory.generatedAt,
    agents: buildEntries(works),
    sessions: orderedSessions,
    limitations,
    summary: summarize(works, orderedSessions),
  });

  if (persist) {
    saveAgentInventoryReport(inventory, layout);
    saveAgentCollectionReport(collectionReport, layout);
  }
  return collectionReport;
}

// ---------- 采集主体 ----------

function discoverRoots(
  inventory: AgentInventoryReport,
  catalog: readonly AgentDescriptor[],
  limits: AgentCollectionLimits,
): {
  works: RootWork[];
  unreadableRoots: number;
  truncatedRoots: number;
  missingCatalogAgents: number;
  missingCatalogRoots: number;
  rootlessAgents: string[];
} {
  const works: RootWork[] = [];
  let unreadableRoots = 0;
  let truncatedRoots = 0;
  let missingCatalogAgents = 0;
  let missingCatalogRoots = 0;
  const rootlessAgents: string[] = [];

  for (const agent of inventory.agents) {
    if (!agent.installed) continue;
    const descriptor = findAgentDescriptor(catalog, agent.agentId);
    if (descriptor === undefined) {
      missingCatalogAgents += 1;
      continue;
    }
    if (descriptor.logRoots.length === 0) {
      rootlessAgents.push(agent.displayName);
      works.push({
        agentId: agent.agentId,
        displayName: agent.displayName,
        rootId: '',
        path: '',
        declaredKind: agent.traceSourceKind ?? 'unknown',
        files: [],
        readable: true,
        truncated: false,
        collectedFiles: 0,
        skippedFiles: 0,
        failedFiles: 0,
      });
      continue;
    }
    for (const rootStatus of agent.logRoots) {
      const root = descriptor.logRoots.find((entry) => entry.rootId === rootStatus.rootId);
      if (root === undefined) {
        missingCatalogRoots += 1;
        continue;
      }
      const scan = scanAgentLogRoot({
        root,
        rootPath: resolveRootPath(rootStatus.path),
        maxSessionFiles: limits.maxSessionFilesPerRoot,
        maxDirectories: limits.maxDirectoriesPerRoot,
      });
      // 「这个根本来就没有」不是限制：只有存在却读不全的根才需要向使用者交代。
      if (!scan.status.readable && scan.status.exists) unreadableRoots += 1;
      if (scan.status.truncated) truncatedRoots += 1;
      works.push({
        agentId: agent.agentId,
        displayName: agent.displayName,
        rootId: root.rootId,
        path: scan.status.path,
        declaredKind: root.traceSourceKind,
        files: scan.files,
        readable: scan.status.readable,
        truncated: scan.status.truncated,
        collectedFiles: 0,
        skippedFiles: 0,
        failedFiles: 0,
      });
    }
  }
  return {
    works,
    unreadableRoots,
    truncatedRoots,
    missingCatalogAgents,
    missingCatalogRoots,
    rootlessAgents,
  };
}

interface CollectOneFileInput {
  candidate: Candidate;
  layout: AgentStorageLayout;
  collectedAt: string;
  persist: boolean;
  writtenArtifacts: Set<string>;
  parseFailures: string[];
  emptySessions: string[];
  readFailures: string[];
}

interface CollectOneFileResult {
  sessions: CollectedSession[];
  duplicates: number;
}

/** 读不了／解析失败／零会话都在内部计入 failedFiles 并返回空列表，单文件失败不中断整轮。 */
function collectOneFile(input: CollectOneFileInput): CollectOneFileResult {
  const { work, file } = input.candidate;
  const contentDigest = digestFile(file.path);
  if (contentDigest === undefined) {
    work.failedFiles += 1;
    input.readFailures.push(file.path);
    return { sessions: [], duplicates: 0 };
  }
  let sessions: TraceSession[];
  try {
    sessions = loadTraceCorpus(file.path).sessions;
  } catch (cause) {
    work.failedFiles += 1;
    input.parseFailures.push(`${file.path}（${cause instanceof Error ? cause.message : String(cause)}）`);
    return { sessions: [], duplicates: 0 };
  }
  if (sessions.length === 0) {
    work.failedFiles += 1;
    input.emptySessions.push(file.path);
    return { sessions: [], duplicates: 0 };
  }

  const collected: CollectedSession[] = [];
  let duplicates = 0;
  for (const session of sessions) {
    const artifactPath = artifactRelativePath(work.agentId, session.traceId);
    const artifactFile = join(input.layout.observeAgentsTracesDir, work.agentId, artifactFileName(session.traceId));
    if (input.writtenArtifacts.has(artifactFile)) {
      // 同一 traceId 已经是已登记证据，不用后写入者覆盖先写入者。
      duplicates += 1;
      continue;
    }
    const artifact: AgentTraceArtifact = {
      schemaVersion: AGENT_TRACE_ARTIFACT_VERSION,
      agentId: work.agentId,
      rootId: work.rootId,
      sourceKind: session.sourceKind,
      sourcePath: file.path,
      collectedAt: input.collectedAt,
      contentDigest,
      session,
    };
    writeArtifact(artifactFile, artifact, input.persist);
    input.writtenArtifacts.add(artifactFile);
    collected.push(buildCollectedSession({
      work,
      file,
      session,
      artifactPath,
      contentDigest,
    }));
  }
  return { sessions: collected, duplicates };
}

function buildCollectedSession(input: {
  work: RootWork;
  file: ScannedSessionFile;
  session: TraceSession;
  artifactPath: string;
  contentDigest: string;
}): CollectedSession {
  const { work, file, session } = input;
  const title = sessionTitle(session);
  const dispositions = countUnknownEventDispositions(session);
  return {
    agentId: work.agentId,
    rootId: work.rootId,
    sourceKind: session.sourceKind,
    sourcePath: file.path,
    runId: session.runId,
    traceId: session.traceId,
    artifactPath: input.artifactPath,
    sizeBytes: file.sizeBytes,
    modifiedAt: file.modifiedAt,
    contentDigest: input.contentDigest,
    eventCount: session.events.length,
    unknownEventCount: dispositions.unsupported,
    duplicateViewCount: dispositions.duplicateView,
    unmappedEvidenceCount: dispositions.unmappedEvidence,
    ...(session.startTimestamp === undefined ? {} : { startTimestamp: session.startTimestamp }),
    ...(session.endTimestamp === undefined ? {} : { endTimestamp: session.endTimestamp }),
    ...(title === undefined ? {} : { title }),
  };
}

/** 展示用标题：第一条人类提问的折叠文本，不改变任何测量语义。 */
function sessionTitle(session: TraceSession): string | undefined {
  for (const event of session.events) {
    if (event.eventKind !== 'message') continue;
    if (event.role !== 'user' || event.origin !== 'human') continue;
    const folded = event.text.replace(/\s+/g, ' ').trim();
    if (folded) return folded.slice(0, 120);
  }
  return undefined;
}

function buildEntries(works: readonly RootWork[]): AgentCollectionEntry[] {
  const byAgent = new Map<string, { displayName: string; roots: AgentCollectionEntry['logRoots'] }>();
  for (const work of works) {
    const entry = byAgent.get(work.agentId) ?? { displayName: work.displayName, roots: [] };
    if (work.rootId !== '') {
      entry.roots.push({
        rootId: work.rootId,
        path: work.path,
        traceSourceKind: TraceSourceKindSchema.parse(work.declaredKind),
        discoveredCount: work.files.length,
        collectedCount: work.collectedFiles,
        skippedCount: work.skippedFiles,
        failedCount: work.failedFiles,
      });
    }
    byAgent.set(work.agentId, entry);
  }
  return [...byAgent.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([agentId, entry]) => ({
      agentId,
      displayName: entry.displayName,
      logRoots: entry.roots,
    }));
}

function summarize(
  works: readonly RootWork[],
  sessions: readonly CollectedSession[],
): AgentCollectionReport['summary'] {
  const bytes = sessions.reduce((sum, session) => sum + session.sizeBytes, 0);
  return {
    agentCount: new Set(works.map((work) => work.agentId)).size,
    discoveredCount: works.reduce((sum, work) => sum + work.files.length, 0),
    collectedCount: works.reduce((sum, work) => sum + work.collectedFiles, 0),
    skippedCount: works.reduce((sum, work) => sum + work.skippedFiles, 0),
    failedCount: works.reduce((sum, work) => sum + work.failedFiles, 0),
    eventCount: sessions.reduce((sum, session) => sum + session.eventCount, 0),
    unknownEventCount: sessions.reduce((sum, session) => sum + session.unknownEventCount, 0),
    duplicateViewCount: sessions.reduce((sum, session) => sum + session.duplicateViewCount, 0),
    unmappedEvidenceCount: sessions.reduce((sum, session) => sum + session.unmappedEvidenceCount, 0),
    totalBytes: bytes,
  };
}

// ---------- 存储读写 ----------

export function agentCollectionReportPath(
  dir: string = globalLayout().observeAgentsDir,
): string {
  return join(dir, COLLECTION_REPORT_FILE_NAME);
}

/** 从任意 Agent 根目录构造采集布局，与全局 layout 的命名保持一致。 */
export function agentStorageLayout(dir: string): AgentStorageLayout {
  const root = resolve(dir);
  return Object.freeze({
    observeAgentsDir: root,
    observeAgentsInventoryPath: join(root, 'inventory.json'),
    observeAgentsTracesDir: join(root, 'traces'),
  });
}

/**
 * 读取上一次的识别报告：文件不存在返回 undefined，存在但无法解析则抛错。
 * 两者语义不同——「还没识别过」与「记录读不动」必须由调用方分开呈现，不能合并成一个空页。
 */
export function loadAgentInventoryReport(
  dirOrLayout: string | AgentStorageLayout = globalLayout(),
): AgentInventoryReport | undefined {
  const layout = typeof dirOrLayout === 'string' ? agentStorageLayout(dirOrLayout) : dirOrLayout;
  if (!existsSync(layout.observeAgentsInventoryPath)) return undefined;
  return AgentInventoryReportSchema.parse(JSON.parse(readFileSync(layout.observeAgentsInventoryPath, 'utf-8')));
}

/**
 * 读取上一次的采集报告：文件不存在返回 undefined；存在但无法解析则抛错，
 * 由 `collectAgentLogs()` 降级为「按全量重新采集」并在 limitations 里说明。
 */
export function loadAgentCollectionReport(
  dir?: string,
): AgentCollectionReport | undefined {
  const path = agentCollectionReportPath(dir);
  if (!existsSync(path)) return undefined;
  return parseCollectionReport(path);
}

export function saveAgentCollectionReport(
  report: AgentCollectionReport,
  dirOrLayout: string | AgentStorageLayout = globalLayout(),
): string {
  const dir = typeof dirOrLayout === 'string' ? dirOrLayout : dirOrLayout.observeAgentsDir;
  const path = agentCollectionReportPath(dir);
  writeJsonFileAtomic(path, report);
  return path;
}

export function saveAgentInventoryReport(
  report: AgentInventoryReport,
  layout: AgentStorageLayout = globalLayout(),
): string {
  writeJsonFileAtomic(layout.observeAgentsInventoryPath, report);
  return layout.observeAgentsInventoryPath;
}

function readPreviousCollection(layout: AgentStorageLayout): {
  index: Map<string, CollectedSession>;
  invalid: boolean;
  outdatedVersion?: string;
} {
  const path = agentCollectionReportPath(layout.observeAgentsDir);
  const index = new Map<string, CollectedSession>();
  if (!existsSync(path)) return { index, invalid: false };
  let report: AgentCollectionReport;
  try {
    report = parseCollectionReport(path);
  } catch (cause) {
    return cause instanceof AgentCollectionReportOutdatedError
      ? { index, invalid: false, outdatedVersion: cause.foundVersion }
      : { index, invalid: true };
  }
  for (const session of report.sessions) {
    index.set(session.sourcePath, session);
  }
  return { index, invalid: false };
}

function parseCollectionReport(path: string): AgentCollectionReport {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  const foundVersion = isObjectLike(raw) && typeof raw.schemaVersion === 'string'
    ? raw.schemaVersion
    : undefined;
  if (foundVersion !== undefined
    && (SUPERSEDED_AGENT_COLLECTION_VERSIONS as readonly string[]).includes(foundVersion)) {
    throw new AgentCollectionReportOutdatedError(foundVersion, path, '未识别事件还没有分桶，计数与当前口径不可同比');
  }
  const report = AgentCollectionReportSchema.parse(raw);
  if (report.unknownDispositionRulesVersion !== UNKNOWN_DISPOSITION_RULES_VERSION) {
    throw new AgentCollectionReportOutdatedError(
      report.unknownDispositionRulesVersion,
      path,
      '未识别事件的分桶与归属口径已更新，旧计数不可沿用',
    );
  }
  return report;
}

/**
 * 报告读得懂但属于已被取代的口径：与「文件损坏」必须分开，前者只需要重新采集，
 * 后者说明落盘内容本身有问题。
 */
export class AgentCollectionReportOutdatedError extends Error {
  constructor(
    readonly foundVersion: string,
    readonly reportPath: string,
    readonly reason: string,
  ) {
    super(`采集报告 ${reportPath} 已过期：${foundVersion}，${reason}。运行 omk agents collect 会按当前口径重新采集。`);
    this.name = 'AgentCollectionReportOutdatedError';
  }
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------- 小工具 ----------

/** 清单里的路径已是绝对路径；这里只规范化，相对路径按当前工作目录兜底。 */
function resolveRootPath(inventoryPath: string): string {
  return resolve(inventoryPath);
}

/**
 * 会话产物逐事件落盘。整篇 `JSON.stringify(artifact, null, 2)` 会在一整场事件之外再复制
 * 一份同量级的字符串（实测 1.35 GiB 日志的采集峰值里约 940 MiB 来自这一次调用），等于把
 * 驻留重新绑回事件总量。这里按键序逐段写出，任意时刻只有单个事件被序列化；产物字节与
 * `writeJsonFileAtomic` 完全一致，并沿用临时文件 + rename 的原子发布语义。
 */
function writeArtifact(artifactFile: string, artifact: AgentTraceArtifact, persist: boolean): void {
  if (!persist) return;
  mkdirSync(dirname(artifactFile), { recursive: true });
  const tempPath = `${artifactFile}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tempPath, 'w');
  let closed = false;
  try {
    const betweenFields = makeFieldSeparator();
    writeAll(fd, '{\n');
    for (const [key, value] of Object.entries(artifact)) {
      if (key === 'session') writeSessionField(fd, artifact.session, betweenFields);
      else writeAll(fd, betweenFields() + jsonField(key, value, 1));
    }
    writeAll(fd, '\n}');
    closeSync(fd);
    closed = true;
    renameSync(tempPath, artifactFile);
  } finally {
    if (!closed) closeSync(fd);
    rmSync(tempPath, { force: true });
  }
}

function writeSessionField(fd: number, session: TraceSession, betweenFields: () => string): void {
  const betweenSessionFields = makeFieldSeparator();
  writeAll(fd, `${betweenFields()}${indent(1)}"session": {\n`);
  const fields: [string, unknown][] = Object.entries(session);
  for (const [key, value] of fields) {
    if (value === undefined) continue; // 与 JSON.stringify 一致：值为 undefined 的键整行省略
    if (key === 'events') {
      const events = session.events;
      writeAll(fd, `${betweenSessionFields()}${jsonEventKey(events.length)}`);
      events.forEach((event, index) => {
        writeAll(fd, `\n${jsonAtDepth(event, 3)}${index === events.length - 1 ? '' : ','}`);
      });
      writeAll(fd, events.length === 0 ? '' : `\n${indent(2)}]`);
    } else {
      writeAll(fd, betweenSessionFields() + jsonField(key, value, 2));
    }
  }
  writeAll(fd, `\n${indent(1)}}`);
}

/** `"events": ` 的键行：空数组直接收成 `[]`，否则留一个未闭合的 `[` 等逐事件写入。 */
function jsonEventKey(eventCount: number): string {
  return eventCount === 0 ? `${indent(2)}"events": []` : `${indent(2)}"events": [`;
}

/** `writeSync` 允许短写，按未落盘的字节续写；位置传 null 才能沿文件游标推进。 */
function writeAll(fd: number, chunk: string): void {
  const buffer = Buffer.from(chunk);
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset, null);
  }
}

function makeFieldSeparator(): () => string {
  let pending = false;
  return () => {
    const text = pending ? ',\n' : '';
    pending = true;
    return text;
  };
}

function indent(depth: number): string {
  return ' '.repeat(depth * 2);
}

/** 与 `JSON.stringify(value, null, 2)` 逐字一致，只是整体下沉 `depth` 层缩进。 */
function jsonAtDepth(value: unknown, depth: number): string {
  const text = JSON.stringify(value, null, 2);
  if (!text.includes('\n')) return text;
  const pad = indent(depth);
  return text.split('\n').map((line) => `${pad}${line}`).join('\n');
}

/** 单个字段的输出片段：键落在 `depth` 层缩进上，值内部的行为 `depth + 1` 层。 */
function jsonField(key: string, value: unknown, depth: number): string {
  // 包装对象本身是根，键自带一层缩进，因此整体只下沉 `depth - 1` 层。
  const text = jsonAtDepth({ [key]: value }, depth - 1);
  const bound = indent(depth - 1).length + 2; // 前后各去掉 `缩进 + 花括号 + 换行`
  return text.slice(bound, text.length - bound);
}

function artifactRelativePath(agentId: string, traceId: string): string {
  return ['traces', agentId, artifactFileName(traceId)].join('/');
}

/** traceId 形如 `trace:<32hex>`；文件名替换掉非字母数字字符，保持跨平台可传输。 */
function artifactFileName(traceId: string): string {
  return `${traceId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

function artifactStillPresent(
  layout: AgentStorageLayout,
  entry: CollectedSession,
): boolean {
  const segments = entry.artifactPath.split('/');
  if (segments.some((segment) => segment === '..' || isAbsolute(segment))) return false;
  return existsSync(join(layout.observeAgentsDir, ...segments));
}

/**
 * 边读边摘要。整份文件的 Buffer 一旦在解析期间被持有，超限会话的内存峰值就会与文件大小
 * 线性相关（实测 1.35 GiB 日志的峰值驻留里有约 2.7 GiB 来自这类全文读取）。
 */
function digestFile(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(TRACE_DIGEST_CHUNK_BYTES);
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
  return `sha256:${hash.digest('hex')}`;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function compareSessionOrder(a: CollectedSession, b: CollectedSession): number {
  return a.sourcePath.localeCompare(b.sourcePath)
    || a.traceId.localeCompare(b.traceId)
    || a.agentId.localeCompare(b.agentId);
}

function enumerate(paths: readonly string[]): string {
  const head = paths.slice(0, MAX_ENUMERATED_PATHS).join('、');
  const rest = paths.length - Math.min(paths.length, MAX_ENUMERATED_PATHS);
  return rest > 0 ? `${head} 等 ${paths.length} 个路径` : head;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024 * 1024))} GiB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} 字节`;
}
