/**
 * 日志根扫描：把一个声明式日志根变成可核对的计数与文件清单。
 *
 * 口径固定为三件事：
 * - 计数完整可信才登记数字：任何一次 readdir/stat 失败都把整个根降级为
 *   `readable: false` 且计数归零，避免「扫到一半」被当成全量。
 * - 容量截断必须显式：命中文件数或目录数上限时 `truncated: true`，数字仍是已扫到的量。
 * - 软链接不得越根：与 trace/source.ts 同一纪律，越界的符号链接直接忽略，不算不可读。
 */

import { join } from 'node:path';
import type { AgentLogRootDescriptor, AgentLogRootStatus } from './contracts.js';
import {
  isMissingPathError,
  isWithinRoot,
  REAL_AGENT_FS_PORTS,
  type AgentDirectoryEntry,
  type AgentFsPorts,
} from './fs-ports.js';

export const DEFAULT_MAX_SESSION_FILES_PER_ROOT = 5000;
export const DEFAULT_MAX_DIRECTORIES_PER_ROOT = 1000;

/** 与 trace 扫描一致的跳过名单：这些目录里的 jsonl 不是会话证据。 */
const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', '.git']);

export interface ScannedSessionFile {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface AgentLogRootScanResult {
  status: AgentLogRootStatus;
  files: ScannedSessionFile[];
}

export interface AgentLogRootScanOptions {
  root: AgentLogRootDescriptor;
  /** 已解析的绝对路径（来自主目录相对路径）。 */
  rootPath: string;
  ports?: AgentFsPorts;
  maxSessionFiles?: number;
  maxDirectories?: number;
}

export function scanAgentLogRoot(options: AgentLogRootScanOptions): AgentLogRootScanResult {
  const ports = options.ports ?? REAL_AGENT_FS_PORTS;
  const maxSessionFiles = positiveCap(options.maxSessionFiles, DEFAULT_MAX_SESSION_FILES_PER_ROOT);
  const maxDirectories = positiveCap(options.maxDirectories, DEFAULT_MAX_DIRECTORIES_PER_ROOT);
  const base = {
    rootId: options.root.rootId,
    path: options.rootPath,
    traceSourceKind: options.root.traceSourceKind,
  };

  let rootStat: ReturnType<AgentFsPorts['stat']>;
  try {
    rootStat = ports.stat(options.rootPath);
  } catch (cause) {
    // 「这里什么都没有」与「有但读不了」都归零，但 exists 必须按错误性质分开登记。
    return { status: unreadableStatus(base, !isMissingPathError(cause)), files: [] };
  }
  if (!rootStat.isDirectory()) {
    return { status: unreadableStatus(base, true), files: [] };
  }

  try {
    return scanExistingRoot({ ...options, ports, maxSessionFiles, maxDirectories, base });
  } catch {
    // 扫描中途失败：无法判断还漏了多少文件，计数归零并标记不可读，而不是给出半份数字。
    return { status: unreadableStatus(base, true), files: [] };
  }
}

function scanExistingRoot(options: AgentLogRootScanOptions & {
  ports: AgentFsPorts;
  maxSessionFiles: number;
  maxDirectories: number;
  base: Pick<AgentLogRootStatus, 'rootId' | 'path' | 'traceSourceKind'>;
}): AgentLogRootScanResult {
  const { root, ports, maxSessionFiles, maxDirectories, base } = options;
  const scanRoot = ports.realpath(options.rootPath);
  const extensions = root.matchExtensions.map((extension) => extension.toLowerCase());
  const visitedDirs = new Set<string>([scanRoot]);
  const visitedFiles = new Set<string>();
  const files: ScannedSessionFile[] = [];
  let truncated = false;
  let directoriesVisited = 0;
  const queue: string[] = [options.rootPath];

  while (queue.length > 0) {
    if (directoriesVisited >= maxDirectories) {
      truncated = true;
      break;
    }
    directoriesVisited += 1;
    const directory = queue.shift() as string;
    for (const entry of ports.readdir(directory).slice().sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
      const entryPath = join(directory, entry.name);
      const resolved = resolveEntryKind(ports, entry, entryPath, scanRoot);
      if (resolved === undefined) continue;

      if (resolved.entryKind === 'file') {
        if (!hasTraceExtension(entry.name, extensions)) continue;
        if (resolved.realPath !== undefined) {
          if (visitedFiles.has(resolved.realPath)) continue;
          visitedFiles.add(resolved.realPath);
        }
        if (files.length >= maxSessionFiles) {
          truncated = true;
          break;
        }
        files.push({
          path: entryPath,
          sizeBytes: resolved.stat?.size ?? 0,
          modifiedAt: toIso(resolved.stat?.mtimeMs ?? 0),
        });
      } else if (resolved.entryKind === 'directory' && root.recursive) {
        if (resolved.realPath === undefined || !visitedDirs.has(resolved.realPath)) {
          if (resolved.realPath !== undefined) visitedDirs.add(resolved.realPath);
          queue.push(entryPath);
        }
      }
    }
    if (truncated) break;
  }

  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const newest = files.reduce<string | undefined>(
    (latest, file) => (latest === undefined || file.modifiedAt > latest ? file.modifiedAt : latest),
    undefined,
  );
  return {
    status: {
      ...base,
      exists: true,
      readable: true,
      sessionFileCount: files.length,
      totalBytes,
      ...(newest === undefined ? {} : { newestModifiedAt: newest }),
      truncated,
    },
    files,
  };
}

interface ResolvedEntry {
  entryKind: 'file' | 'directory' | 'other';
  /** 仅符号链接与非符号链接目录需要真实路径；普通文件按名判定扩展即可。 */
  realPath?: string;
  stat?: ReturnType<AgentFsPorts['stat']>;
}

function resolveEntryKind(
  ports: AgentFsPorts,
  entry: AgentDirectoryEntry,
  entryPath: string,
  scanRoot: string,
): ResolvedEntry | undefined {
  if (entry.entryKind !== 'symlink') {
    if (entry.entryKind === 'directory') {
      const realPath = ports.realpath(entryPath);
      return { entryKind: 'directory', realPath };
    }
    if (entry.entryKind === 'file') {
      return { entryKind: 'file', stat: ports.stat(entryPath) };
    }
    return { entryKind: 'other' };
  }
  // 软链接：目标越出日志根就忽略，断链同样忽略；两者都不算「这个根不可读」。
  let realPath: string;
  let stat: ReturnType<AgentFsPorts['stat']>;
  try {
    realPath = ports.realpath(entryPath);
    stat = ports.stat(entryPath);
  } catch {
    return undefined;
  }
  if (!isWithinRoot(scanRoot, realPath)) return undefined;
  return {
    entryKind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    realPath,
    stat,
  };
}

function hasTraceExtension(name: string, extensions: readonly string[]): boolean {
  const lowered = name.toLowerCase();
  return extensions.some((extension) => lowered.endsWith(extension));
}

function unreadableStatus(
  base: Pick<AgentLogRootStatus, 'rootId' | 'path' | 'traceSourceKind'>,
  exists: boolean,
): AgentLogRootStatus {
  return {
    ...base,
    exists,
    readable: false,
    sessionFileCount: 0,
    totalBytes: 0,
    truncated: false,
  };
}

function positiveCap(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function toIso(mtimeMs: number): string {
  return new Date(mtimeMs).toISOString();
}
