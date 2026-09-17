import type {
  AgentDirectoryEntry,
  AgentFsPorts,
  AgentFsStat,
} from '../../../src/observability/agents/fs-ports.js';

/**
 * 只读端口用的内存文件系统。
 *
 * 它刻意只实现 stat/readdir/realpath：没有内容读取、没有 exec/spawn。
 * 用例因此不可能在「端口里有执行能力」的前提下通过——检测阶段能拿到的信息上限
 * 就是目录结构与元数据。
 */

type NodeKind = 'directory' | 'file' | 'symlink';

interface FakeNode {
  kind: NodeKind;
  target?: string;
  size: number;
  mtimeMs: number;
  mode: number;
  /** true 时 stat 抛 EACCES，模拟整个根无权限。 */
  unreadable?: boolean;
  /** true 时 stat 正常但 readdir 抛 EACCES，模拟「进得去门、读不了目录表」。 */
  unlistable?: boolean;
}

interface ResolvedNode extends FakeNode {
  realPath: string;
}

function errorWithCode(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${code} ${path}`), { code });
}

export const FAKE_MTIME_MS = Date.parse('2026-05-18T09:51:00.000Z');

export const HOME = '/home/tester';

export class FakeFileSystem {
  private readonly nodes = new Map<string, FakeNode>();

  constructor(readonly home: string = HOME) {
    this.nodes.set('/', { kind: 'directory', size: 0, mtimeMs: 0, mode: 0o755 });
    this.mkdir(home);
  }

  mkdir(path: string): this {
    const segments: string[] = [];
    for (const segment of normalize(path).split('/')) {
      if (!segment) continue;
      segments.push(segment);
      this.touch(`/${segments.join('/')}`, { kind: 'directory', size: 0, mtimeMs: FAKE_MTIME_MS, mode: 0o755 });
    }
    return this;
  }

  file(path: string, options: { size?: number; mtimeMs?: number } = {}): this {
    this.mkdir(parentOf(path));
    this.nodes.set(normalize(path), {
      kind: 'file',
      size: options.size ?? 128,
      mtimeMs: options.mtimeMs ?? FAKE_MTIME_MS,
      mode: 0o644,
    });
    return this;
  }

  /** PATH 上的可执行入口。 */
  executable(path: string): this {
    this.file(path);
    (this.nodes.get(normalize(path)) as FakeNode).mode = 0o755;
    return this;
  }

  /** 同名但不可执行的文件：不构成安装证据。 */
  nonExecutable(path: string): this {
    return this.file(path);
  }

  symlink(path: string, target: string): this {
    this.mkdir(parentOf(path));
    this.nodes.set(normalize(path), {
      kind: 'symlink',
      target: normalize(target),
      size: 0,
      mtimeMs: FAKE_MTIME_MS,
      mode: 0o777,
    });
    return this;
  }

  /** 目录存在但 stat 就读不了。 */
  unreadableDirectory(path: string): this {
    this.mkdir(path);
    (this.nodes.get(normalize(path)) as FakeNode).unreadable = true;
    return this;
  }

  /** 目录可 stat，但列目录失败：扫描中途的不可读必须整体降级。 */
  unlistableDirectory(path: string): this {
    this.mkdir(path);
    (this.nodes.get(normalize(path)) as FakeNode).unlistable = true;
    return this;
  }

  ports(): AgentFsPorts {
    return {
      stat: (path) => this.stat(path),
      readdir: (path) => this.readdir(path),
      realpath: (path) => this.realpath(path),
    };
  }

  private stat(path: string): AgentFsStat {
    const node = this.resolve(path);
    return {
      isDirectory: () => node.kind === 'directory',
      isFile: () => node.kind === 'file',
      size: node.size,
      mtimeMs: node.mtimeMs,
      mode: node.mode,
    };
  }

  private readdir(path: string): AgentDirectoryEntry[] {
    const directory = this.resolve(path);
    if (directory.kind !== 'directory') throw errorWithCode('ENOTDIR', path);
    if (directory.unreadable || directory.unlistable) throw errorWithCode('EACCES', path);
    const parent = directory.realPath;
    const entries: AgentDirectoryEntry[] = [];
    for (const [entryPath, node] of this.nodes) {
      if (parentOf(entryPath) !== parent) continue;
      entries.push({
        name: baseOf(entryPath),
        entryKind: node.kind === 'directory' ? 'directory' : node.kind === 'file' ? 'file' : 'symlink',
      });
    }
    return entries;
  }

  private realpath(path: string): string {
    return this.resolve(path).realPath;
  }

  private resolve(path: string): ResolvedNode {
    const node = this.follow(normalize(path), 0);
    if (node.unreadable) throw errorWithCode('EACCES', path);
    return node;
  }

  private follow(path: string, depth: number): ResolvedNode {
    const node = this.nodes.get(path);
    if (node === undefined) throw errorWithCode('ENOENT', path);
    if (node.kind !== 'symlink') return { ...node, realPath: path };
    if (depth > 8) throw errorWithCode('ELOOP', path);
    const target = this.follow(node.target as string, depth + 1);
    // 与真实 fs.statSync 一致：软链接按目标呈现类型与元数据，真实路径指向目标。
    return {
      ...node,
      kind: target.kind,
      size: target.size,
      mtimeMs: target.mtimeMs,
      mode: target.mode,
      unreadable: target.unreadable,
      unlistable: target.unlistable,
      realPath: target.realPath,
    };
  }

  private touch(path: string, node: FakeNode): void {
    if (!this.nodes.has(path)) this.nodes.set(path, node);
  }
}

function normalize(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

function parentOf(path: string): string {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

function baseOf(path: string): string {
  const normalized = normalize(path);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}
