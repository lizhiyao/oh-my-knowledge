/**
 * 本机 Agent 检测的只读文件系统端口。
 *
 * 端口刻意只暴露「列目录 / 取元数据 / 解析真实路径」三种能力：没有 exec、spawn，也没有
 * open/read，因此检测在类型层面就不可能运行第三方二进制，也不可能读到会话正文。
 * 采集阶段（collect.ts）必须复用既有 trace 解析器，那里只接受真实路径，所以走真实 fs，
 * 不接收这里的注入端口——否则发现阶段与解析阶段会看到两个不同的世界。
 */

import { readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface AgentFsStat {
  isDirectory(): boolean;
  isFile(): boolean;
  size: number;
  mtimeMs: number;
  /** POSIX mode bits；用于判断 PATH 上的候选文件是否可执行。 */
  mode: number;
}

export type AgentDirectoryEntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface AgentDirectoryEntry {
  name: string;
  kind: AgentDirectoryEntryKind;
}

export interface AgentFsPorts {
  /** 跟随符号链接：目标是断链时抛错，由调用方按降级路径处理。 */
  stat(path: string): AgentFsStat;
  /** 不解析符号链接：`kind === 'symlink'` 是越界判断的入口。 */
  readdir(path: string): AgentDirectoryEntry[];
  /** 真实路径；符号链接是否留在根内、是否越出主目录，都以此判定。 */
  realpath(path: string): string;
}

/** 采集/检测的默认端口：只有这三个只读入口。 */
export const REAL_AGENT_FS_PORTS: AgentFsPorts = Object.freeze({
  stat(path: string): AgentFsStat {
    const stat = statSync(path);
    return {
      isDirectory: () => stat.isDirectory(),
      isFile: () => stat.isFile(),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mode: stat.mode,
    };
  },
  readdir(path: string): AgentDirectoryEntry[] {
    return readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      kind: entry.isSymbolicLink()
        ? 'symlink'
        : entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : 'other',
    }));
  },
  realpath(path: string): string {
    return realpathSync(path);
  },
});

/** 与 trace/source.ts 的 `isWithinTraceRoot` 同一口径：真实路径必须留在根内。 */
export function isWithinRoot(rootRealPath: string, candidateRealPath: string): boolean {
  const rel = relative(rootRealPath, candidateRealPath);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

/**
 * 登记表里的路径一律相对用户主目录。这里拒绝绝对路径、盘符路径和任何 `..` 越界段，
 * 使「日志根的软链接指向别处」与「登记条目把用户目录之外写成日志根」两类越界在同一处失效。
 */
export function assertSafeHomeRelativePath(relativePath: string): void {
  const normalized = relativePath.replaceAll('\\', '/');
  if (!normalized || isAbsolute(relativePath) || WINDOWS_DRIVE_RE.test(relativePath)) {
    throw new Error(`Agent 登记条目必须使用主目录相对路径，收到：${relativePath}`);
  }
  const segments = normalized.split('/');
  for (const [index, segment] of segments.entries()) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error(`Agent 登记条目包含不安全的路径段，收到：${relativePath}（第 ${index + 1} 段）`);
    }
  }
}

/** 主目录相对路径 → 绝对路径；不做 exists 判断，只做路径拼装与越界校验。 */
export function resolveHomeRelativePath(homeDirectory: string, relativePath: string): string {
  assertSafeHomeRelativePath(relativePath);
  const segments = relativePath.replaceAll('\\', '/').split('/');
  return resolve(homeDirectory, ...segments);
}

/** Node fs 错误带 `code`；测试用的假端口沿用同一形态。 */
export function fsErrorCode(cause: unknown): string | undefined {
  return typeof (cause as { code?: unknown })?.code === 'string'
    ? (cause as { code: string }).code
    : undefined;
}

/** ENOENT/ENOTDIR 表示「这里什么都没有」，与「有但读不了」必须区分登记。 */
export function isMissingPathError(cause: unknown): boolean {
  const code = fsErrorCode(cause);
  return code === 'ENOENT' || code === 'ENOTDIR';
}
