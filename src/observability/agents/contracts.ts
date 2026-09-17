/**
 * 本机 Agent 清单与日志采集的数据契约。
 *
 * agentId 表达「装了哪个产品」，traceSourceKind 表达「日志属于哪种 omk 已支持的格式」，
 * 两者故意不合并：CodeFuse 落的是 Claude 同族日志，产品身份仍需在报告里单独保留。
 */

import { z } from 'zod';
import { TraceSourceKindSchema } from '../../executors/contracts/trace-source-schema.js';

export const AGENT_INVENTORY_VERSION = 'agent-inventory-v1' as const;
export const AGENT_COLLECTION_VERSION = 'agent-collection-v1' as const;

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
  unknownEventCount: z.number().int().nonnegative(),
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
    unknownEventCount: z.number().int().nonnegative(),
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
