import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { checkStorageDirectory } from '../../evidence/storage/knowledge-workspace.js';

function directories(path: string, workspace: string): string[] {
  const root = resolve(workspace), parent = dirname(resolve(path)), within = relative(root, parent);
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('Knowledge publication must be inside its workspace.');
  const result: string[] = [];
  for (let current = parent; ; current = dirname(current)) {
    result.push(current); if (current === root) return result;
  }
}
function sameFile(left: BigIntStats, right: BigIntStats, includeCtime = true): boolean {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && (!includeCtime || left.ctimeNs === right.ctimeNs);
}
function syncDirectories(paths: readonly string[]): void {
  for (const path of paths) {
    checkStorageDirectory(path); const before = lstatSync(path, { bigint: true });
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Knowledge directory changed before durability confirmation.');
      fsyncSync(fd);
      const current = lstatSync(path, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('Knowledge directory changed during durability confirmation.');
    } finally { closeSync(fd); }
  }
}

/** Called only after exact receipt validation under the workspace lock. Never rewrites stored bytes. */
export function confirmKnowledgePublication(path: string, workspace: string): void {
  const parents = directories(path, workspace); parents.forEach(checkStorageDirectory);
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Invalid knowledge publication file.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!sameFile(before, opened)) throw new Error('Knowledge file changed before durability confirmation.');
    fsyncSync(fd); syncDirectories(parents);
    if (!sameFile(opened, fstatSync(fd, { bigint: true })) || !sameFile(opened, lstatSync(path, { bigint: true }))) throw new Error('Knowledge file changed during durability confirmation.');
  } finally { closeSync(fd); }
}

/** Narrow domain publisher: existing JSON encodings stay caller-owned; acknowledgement follows fsync. */
export function publishKnowledgeBytes(path: string, bytes: string, workspace: string, exclusive: boolean): void {
  const parents = directories(path, workspace); parents.forEach(checkStorageDirectory);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); parents.forEach(checkStorageDirectory);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600); const buffer = Buffer.from(bytes); let offset = 0;
    while (offset < buffer.length) {
      const count = writeSync(fd, buffer, offset, buffer.length - offset);
      if (!Number.isSafeInteger(count) || count <= 0 || count > buffer.length - offset) throw new Error('Knowledge write did not progress.');
      offset += count;
    }
    fsyncSync(fd); const written = fstatSync(fd, { bigint: true });
    if (written.size !== BigInt(buffer.length)) throw new Error('Knowledge temporary file size mismatch.');
    if (!sameFile(written, lstatSync(temp, { bigint: true }))) throw new Error('Knowledge temporary file changed before publication.');
    closeSync(fd); fd = undefined;
    if (exclusive) linkSync(temp, path); else renameSync(temp, path);
    if (existsSync(temp)) rmSync(temp);
    syncDirectories(parents);
    // Link/rename may change ctime. Identity, size and content-modification time must still match.
    if (!sameFile(written, lstatSync(path, { bigint: true }), false)) throw new Error('Knowledge file changed after publication.');
  } finally {
    try { if (fd !== undefined) closeSync(fd); }
    finally { if (existsSync(temp)) rmSync(temp); }
  }
}
