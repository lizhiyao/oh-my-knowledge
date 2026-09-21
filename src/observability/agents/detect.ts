/**
 * 本机 Agent 清单探测：把登记表变成一份可核对、可归档的只读报告。
 *
 * 三条硬口径：
 * - 不执行任何第三方二进制。「装了」只由两类信号证明：PATH 上解析到可执行文件，
 *   或主目录下存在安装状态目录（软链接会解析真实路径，但越出主目录即不采信）。
 * - 不读会话正文。端口里只有 readdir/stat/realpath，检测阶段连 open 通道都没有。
 * - 报告如实：未安装、已安装但无日志、日志根不可读、扫描被容量截断，都要在报告里看得见。
 */

import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import {
  AGENT_INVENTORY_VERSION,
  AgentInventoryReportSchema,
  type AgentDescriptor,
  type AgentInstallEvidence,
  type AgentInventoryReport,
  type AgentLogRootStatus,
  type DetectedAgent,
} from './contracts.js';
import {
  isWithinRoot,
  REAL_AGENT_FS_PORTS,
  resolveHomeRelativePath,
  type AgentFsPorts,
} from './fs-ports.js';
import { KNOWN_AGENTS } from './registry.js';
import { zstdDecompressionAvailable } from '../trace/zstd-frames.js';
import {
  DEFAULT_MAX_DIRECTORIES_PER_ROOT,
  DEFAULT_MAX_SESSION_FILES_PER_ROOT,
  scanAgentLogRoot,
} from './scan.js';

export interface DetectAgentInventoryOptions {
  /** 默认 `os.homedir()`。 */
  homeDirectory?: string;
  /** 默认 `process.platform`；只影响可执行位判定。 */
  platform?: string;
  /** PATH 目录；默认从 `process.env.PATH` 拆分，只保留绝对目录。 */
  pathDirectories?: readonly string[];
  /** 只读文件系统端口；默认走真实 fs。 */
  fsPorts?: AgentFsPorts;
  /**
   * 本机运行时能否解压 zstd；默认取 `zstdDecompressionAvailable()`。显式传 false 用来呈现
   * 「装了、有日志、但这个运行时读不了」这一档，不让用例去伪造旧版 Node。
   */
  zstdAvailable?: boolean;
  /**
   * 登记表；默认只用内置表。要包含本机扩展条目，由调用方传 `resolveAgentCatalog()` 的结果——
   * 探测本身不读用户目录里的配置文件，用例与调用方因此都能掌控输入。
   */
  descriptors?: readonly AgentDescriptor[];
  /** 单个日志根最多统计多少个会话文件；命中即 `truncated: true`。 */
  maxSessionFilesPerRoot?: number;
  /** 单个日志根最多访问多少个目录；命中即 `truncated: true`。 */
  maxDirectoriesPerRoot?: number;
  now?: () => string;
}

export function detectAgentInventory(
  options: DetectAgentInventoryOptions = {},
): AgentInventoryReport {
  const ports = options.fsPorts ?? REAL_AGENT_FS_PORTS;
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const platform = options.platform ?? process.platform;
  const pathDirectories = options.pathDirectories ?? pathDirectoriesFromEnv(process.env.PATH);
  const descriptors = options.descriptors ?? KNOWN_AGENTS;
  const realHome = safeRealpath(ports, homeDirectory);
  const scanContext = {
    ports,
    homeDirectory,
    platform,
    pathDirectories,
    realHome,
    maxSessionFiles: options.maxSessionFilesPerRoot ?? DEFAULT_MAX_SESSION_FILES_PER_ROOT,
    maxDirectories: options.maxDirectoriesPerRoot ?? DEFAULT_MAX_DIRECTORIES_PER_ROOT,
    zstdAvailable: options.zstdAvailable ?? zstdDecompressionAvailable(),
  };

  const agents = descriptors.map((descriptor) => detectOneAgent(descriptor, scanContext));
  return AgentInventoryReportSchema.parse({
    schemaVersion: AGENT_INVENTORY_VERSION,
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    platform,
    homeDirectory,
    agents,
    summary: summarizeAgents(agents, descriptors.length),
  });
}

interface DetectContext {
  ports: AgentFsPorts;
  homeDirectory: string;
  platform: string;
  pathDirectories: readonly string[];
  realHome: string;
  maxSessionFiles: number;
  maxDirectories: number;
  zstdAvailable: boolean;
}

function detectOneAgent(
  descriptor: AgentDescriptor,
  context: DetectContext,
): DetectedAgent {
  const evidence: AgentInstallEvidence[] = [];
  const binaryPath = findBinaryPath(descriptor, context);
  if (binaryPath !== undefined) evidence.push({ via: 'binary', path: binaryPath });
  for (const installDir of descriptor.installDirs) {
    const candidate = resolveHomeRelativePath(context.homeDirectory, installDir);
    if (isInstalledDirectory(candidate, context)) {
      evidence.push({ via: 'install-dir', path: candidate });
    }
  }

  const logRoots = descriptor.logRoots.map((root) => scanRootStatus(root, context));
  return {
    agentId: descriptor.agentId,
    displayName: descriptor.displayName,
    vendor: descriptor.vendor,
    traceSourceKind: descriptor.traceSourceKind,
    installed: evidence.length > 0,
    evidence,
    ...(binaryPath === undefined ? {} : { binaryPath }),
    logRoots,
    sessionFileCount: logRoots.reduce((sum, status) => sum + status.sessionFileCount, 0),
  };
}

/** PATH 顺序即 shell 解析顺序：只取第一个命中，其余副本不作为独立证据。 */
function findBinaryPath(
  descriptor: AgentDescriptor,
  context: DetectContext,
): string | undefined {
  for (const binary of descriptor.binaries) {
    for (const directory of context.pathDirectories) {
      const candidate = join(directory, binary);
      if (isExecutableFile(candidate, context)) return candidate;
    }
  }
  return undefined;
}

function isExecutableFile(candidate: string, context: DetectContext): boolean {
  let stat: ReturnType<AgentFsPorts['stat']>;
  try {
    stat = context.ports.stat(candidate);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  // win32 的 mode 不含可执行位语义，按文件存在即入口处理；darwin/linux 仍检查可执行位。
  return context.platform === 'win32' ? true : (stat.mode & 0o111) !== 0;
}

function isInstalledDirectory(candidate: string, context: DetectContext): boolean {
  try {
    if (!context.ports.stat(candidate).isDirectory()) return false;
    return isWithinRoot(context.realHome, context.ports.realpath(candidate));
  } catch {
    return false;
  }
}

function scanRootStatus(
  root: AgentDescriptor['logRoots'][number],
  context: DetectContext,
): AgentLogRootStatus {
  const { status } = scanAgentLogRoot({
    root,
    rootPath: resolveHomeRelativePath(context.homeDirectory, root.relativePath),
    ports: context.ports,
    maxSessionFiles: context.maxSessionFiles,
    maxDirectories: context.maxDirectories,
  });
  // 有会话文件、目录也可读，但这个运行时解不了该格式：单独记一档，
  // 别把它和「装了但没日志」压成同一句话。
  if (
    root.matchExtensions.includes('.zstd')
    && !context.zstdAvailable
    && status.exists
    && status.readable
    && status.sessionFileCount > 0
  ) {
    return { ...status, unreadableReason: 'needs-zstd-decompression' };
  }
  return status;
}

function summarizeAgents(
  agents: readonly DetectedAgent[],
  knownAgentCount: number,
): AgentInventoryReport['summary'] {
  const roots = agents.flatMap((agent) => agent.logRoots);
  return {
    knownAgentCount,
    installedAgentCount: agents.filter((agent) => agent.installed).length,
    sessionFileCount: agents.reduce((sum, agent) => sum + agent.sessionFileCount, 0),
    rootsWithFiles: roots.filter((root) => root.sessionFileCount > 0).length,
    truncatedRootCount: roots.filter((root) => root.truncated).length,
  };
}

/** 相对 PATH 目录（例如 `` 或 `.`）会指向调用方的 cwd，不作为探测目标。 */
export function pathDirectoriesFromEnv(pathValue: string | undefined): string[] {
  return (pathValue ?? '')
    .split(delimiter)
    .filter((entry) => entry.trim() !== '' && isAbsolute(entry));
}

function safeRealpath(ports: AgentFsPorts, path: string): string {
  try {
    return ports.realpath(path);
  } catch {
    return path;
  }
}
