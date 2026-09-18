/**
 * 本机 Agent 清单与日志采集的公开入口。
 *
 * 与其它 observability 子目录一致：index.ts 只做再导出，探测、扫描与采集的实现留在同级模块，
 * 调用方（CLI／Studio）不需要知道登记表和端口这些内部结构。
 */

export type {
  AgentCollectionEntry,
  AgentCollectionReport,
  AgentDescriptor,
  AgentInstallEvidence,
  AgentInventoryReport,
  AgentLogRootDescriptor,
  AgentLogRootStatus,
  CollectedSession,
  DetectedAgent,
} from './contracts.js';
export {
  AGENT_CATALOG_VERSION,
  AGENT_COLLECTION_VERSION,
  AGENT_INVENTORY_VERSION,
  AgentCatalogFileSchema,
  AgentCollectionEntrySchema,
  AgentCollectionReportSchema,
  AgentDescriptorSchema,
  AgentInstallEvidenceSchema,
  AgentInventoryReportSchema,
  AgentLogRootSchema,
  AgentLogRootStatusSchema,
  CollectedSessionSchema,
  DetectedAgentSchema,
  SUPERSEDED_AGENT_COLLECTION_VERSIONS,
} from './contracts.js';
export { KNOWN_AGENTS, findAgentDescriptor } from './registry.js';
export type { LocalAgentCatalog, LocalAgentCatalogOptions } from './local-catalog.js';
export {
  LocalAgentCatalogError,
  loadLocalAgentCatalog,
  mergeAgentCatalog,
  resolveAgentCatalog,
} from './local-catalog.js';
export { detectAgentInventory, pathDirectoriesFromEnv } from './detect.js';
export type { DetectAgentInventoryOptions } from './detect.js';
export {
  AGENT_TRACE_ARTIFACT_VERSION,
  AgentCollectionReportOutdatedError,
  COLLECTION_REPORT_FILE_NAME,
  DEFAULT_MAX_BYTES_PER_RUN,
  DEFAULT_MAX_SESSION_FILE_BYTES,
  DEFAULT_MAX_SESSION_FILES_PER_RUN,
  agentCollectionReportPath,
  agentStorageLayout,
  collectAgentLogs,
  loadAgentCollectionReport,
  loadAgentInventoryReport,
  saveAgentCollectionReport,
  saveAgentInventoryReport,
} from './collect.js';
export type {
  AgentStorageLayout,
  AgentTraceArtifact,
  CollectAgentLogsOptions,
  AgentCollectionLimits,
} from './collect.js';
export {
  DEFAULT_MAX_DIRECTORIES_PER_ROOT,
  DEFAULT_MAX_SESSION_FILES_PER_ROOT,
  scanAgentLogRoot,
} from './scan.js';
export type { AgentLogRootScanResult, ScannedSessionFile } from './scan.js';
export { REAL_AGENT_FS_PORTS } from './fs-ports.js';
export type {
  AgentDirectoryEntry,
  AgentDirectoryEntryKind,
  AgentFsPorts,
  AgentFsStat,
} from './fs-ports.js';
