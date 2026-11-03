/**
 * 本机 Agent 清单与日志采集的数据契约。
 *
 * agentId 表达「装了哪个产品」，traceSourceKind 表达「日志属于哪种 omk 已支持的格式」，
 * 两者故意不合并：落 Claude 同族日志的产品，其身份仍需在报告里单独保留。
 */

import { z } from 'zod';
import { TraceSourceKindSchema } from '../../executors/contracts/trace-source-schema.js';

/**
 * v2 起日志根状态能表达「目录里有会话文件，但当前运行时读不了这种格式」（`unreadableReason`）。
 * v1 里这种情况与「装了但没日志」长得一样，会把能力缺口说成空目录，因此不自动改写用户磁盘上的
 * 旧清单，只把它识别为旧版本并提示重新识别。
 */
export const AGENT_INVENTORY_VERSION = 'agent-inventory-v2' as const;
export const SUPERSEDED_AGENT_INVENTORY_VERSIONS = ['agent-inventory-v1'] as const;
/**
 * v2 起 `unknownEventCount` 只统计「未支持的记录」，同一事实的重复／累计视图与尚未映射的
 * 唯一证据各自成档。v1 里这个字段是全部未识别事件的总数，两者不可同比，因此不自动改写
 * 用户磁盘上的旧报告，只把它识别为旧口径并提示重新采集。
 */
export const AGENT_COLLECTION_VERSION = 'agent-collection-v2' as const;
export const SUPERSEDED_AGENT_COLLECTION_VERSIONS = ['agent-collection-v1'] as const;
export const AGENT_CATALOG_VERSION = 'agent-catalog-v1' as const;

const agentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const relativePathSchema = z.string().min(1);

/** 只描述格式归属；未知格式留空，采集时降级为 unknown 而不是丢弃。 */
export const AgentLogRootSchema = z.strictObject({
  rootId: agentIdSchema,
  /** 相对用户主目录的日志根路径。 */
  relativePath: relativePathSchema,
  traceSourceKind: TraceSourceKindSchema,
  matchExtensions: z.array(z.string().regex(/^\.[a-z0-9]+$/)).min(1),
  recursive: z.boolean(),
  note: z.string().optional(),
});

export const AgentDescriptorSchema = z.strictObject({
  agentId: agentIdSchema,
  displayName: z.string().min(1),
  vendor: z.string().min(1),
  /** 主日志格式；没有任何已支持格式时为 null，仅登记安装事实。 */
  traceSourceKind: TraceSourceKindSchema.nullable(),
  binaries: z.array(z.string().min(1)),
  installDirs: z.array(relativePathSchema).min(1),
  logRoots: z.array(AgentLogRootSchema),
});

/**
 * 用户级登记表扩展文件（`<OMK_HOME>/agents.json`）的契约：只能声明与内置登记表同形态的条目。
 * strictObject 是有意的——文件里没有执行能力、没有绝对路径字段，任何多余键都当作畸形失效处理。
 */
export const AgentCatalogFileSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_CATALOG_VERSION),
  agents: z.array(AgentDescriptorSchema),
});

export const AgentInstallEvidenceSchema = z.strictObject({
  via: z.enum(['binary', 'install-dir']),
  path: z.string().min(1),
});

export const AgentLogRootStatusSchema = z.strictObject({
  rootId: agentIdSchema,
  path: z.string().min(1),
  traceSourceKind: TraceSourceKindSchema,
  exists: z.boolean(),
  readable: z.boolean(),
  sessionFileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  newestModifiedAt: z.string().optional(),
  /** 扫描被容量上限截断时为 true，报告不得把截断后的计数当作全量。 */
  truncated: z.boolean(),
  /**
   * 发现了会话文件却读不了时的原因；能读时省略。刻意不复用 `readable`——那一位说的是目录
   * 权限，不是格式支持，两者混在一起会把「没权限」和「没能力」报成同一句话。
   */
  unreadableReason: z.enum(['needs-zstd-decompression']).optional(),
});

export const DetectedAgentSchema = z.strictObject({
  agentId: agentIdSchema,
  displayName: z.string().min(1),
  vendor: z.string().min(1),
  traceSourceKind: TraceSourceKindSchema.nullable(),
  installed: z.boolean(),
  evidence: z.array(AgentInstallEvidenceSchema),
  binaryPath: z.string().optional(),
  logRoots: z.array(AgentLogRootStatusSchema),
  sessionFileCount: z.number().int().nonnegative(),
});

export const AgentInventoryReportSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_INVENTORY_VERSION),
  generatedAt: z.string().min(1),
  platform: z.string().min(1),
  homeDirectory: z.string().min(1),
  agents: z.array(DetectedAgentSchema),
  summary: z.strictObject({
    knownAgentCount: z.number().int().nonnegative(),
    installedAgentCount: z.number().int().nonnegative(),
    sessionFileCount: z.number().int().nonnegative(),
    rootsWithFiles: z.number().int().nonnegative(),
    truncatedRootCount: z.number().int().nonnegative(),
  }),
});

export const CollectedSessionSchema = z.strictObject({
  agentId: agentIdSchema,
  rootId: agentIdSchema,
  sourceKind: TraceSourceKindSchema,
  /** 原始日志路径：只登记，不改写、不删除。 */
  sourcePath: z.string().min(1),
  runId: z.string().min(1),
  traceId: z.string().min(1),
  /** 归一化 Trace IR 的落盘相对路径。 */
  artifactPath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAt: z.string().min(1),
  contentDigest: z.string().min(1),
  eventCount: z.number().int().nonnegative(),
  /** 未支持的记录：适配器读不出语义，属于真正的能力缺口。 */
  unknownEventCount: z.number().int().nonnegative(),
  /** 同一事实的重复写入或累计快照：映射成事件会变成双计，刻意不映射。 */
  duplicateViewCount: z.number().int().nonnegative(),
  /** 已识别但尚未决定映射口径的唯一证据。 */
  unmappedEvidenceCount: z.number().int().nonnegative(),
  startTimestamp: z.string().optional(),
  endTimestamp: z.string().optional(),
  title: z.string().optional(),
});

export const AgentCollectionEntrySchema = z.strictObject({
  agentId: agentIdSchema,
  displayName: z.string().min(1),
  logRoots: z.array(z.strictObject({
    rootId: agentIdSchema,
    path: z.string().min(1),
    traceSourceKind: TraceSourceKindSchema,
    discoveredCount: z.number().int().nonnegative(),
    collectedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
  })),
});

export const AgentCollectionReportSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_COLLECTION_VERSION),
  /** 桶归属的推导口径版本；与采集时不一致时旧计数不可复用，必须重算。 */
  unknownDispositionRulesVersion: z.string().min(1),
  generatedAt: z.string().min(1),
  outputDir: z.string().min(1),
  inventoryGeneratedAt: z.string().min(1),
  agents: z.array(AgentCollectionEntrySchema),
  sessions: z.array(CollectedSessionSchema),
  limitations: z.array(z.string()),
  summary: z.strictObject({
    agentCount: z.number().int().nonnegative(),
    discoveredCount: z.number().int().nonnegative(),
    collectedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(),
    /** 未支持的记录总数（能力缺口），不含另外两档。 */
    unknownEventCount: z.number().int().nonnegative(),
    duplicateViewCount: z.number().int().nonnegative(),
    unmappedEvidenceCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
  }),
});

export type AgentLogRootDescriptor = z.infer<typeof AgentLogRootSchema>;
export type AgentDescriptor = z.infer<typeof AgentDescriptorSchema>;
export type AgentInstallEvidence = z.infer<typeof AgentInstallEvidenceSchema>;
export type AgentLogRootStatus = z.infer<typeof AgentLogRootStatusSchema>;
export type DetectedAgent = z.infer<typeof DetectedAgentSchema>;
export type AgentInventoryReport = z.infer<typeof AgentInventoryReportSchema>;
export type CollectedSession = z.infer<typeof CollectedSessionSchema>;
export type AgentCollectionEntry = z.infer<typeof AgentCollectionEntrySchema>;
export type AgentCollectionReport = z.infer<typeof AgentCollectionReportSchema>;
