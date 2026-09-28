import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { digestCanonicalJson, type Sha256Digest } from '../../../eval-core/contracts/index.js';
import { LocalTaskPathSchema, type TaskFile, type LocalTaskOutput } from '../../inputs/contracts/local-task.js';

export function fileDigest(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Explicit files only. A trusted local process is required; this is not a hostile-code sandbox. */
export async function readTaskFile(root: string, path: string, maxBytes: number): Promise<TaskFile> {
  LocalTaskPathSchema.parse(path);
  let parent = resolve(root);
  for (const part of ['', ...path.split('/').slice(0, -1)]) {
    parent = join(parent, part);
    const metadata = await lstat(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('TASK_PATH_UNSAFE');
  }
  const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('TASK_PATH_UNSAFE');
    if (metadata.size > maxBytes) throw new Error('TASK_FILE_LIMIT');
    // Bound the actual read, including a file growing after stat().
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error('TASK_FILE_LIMIT');
    const bytes = buffer.subarray(0, length);
    return { path, contentBase64: bytes.toString('base64'), digest: fileDigest(bytes), executable: (metadata.mode & 0o111) !== 0 };
  } finally { await handle.close(); }
}

export async function captureTaskFiles(root: string, paths: readonly string[], maxBytes: number): Promise<readonly TaskFile[]> {
  const files: TaskFile[] = [];
  let remaining = maxBytes;
  for (const path of [...paths].sort()) {
    const file = await readTaskFile(root, path, remaining);
    remaining -= Buffer.from(file.contentBase64, 'base64').length;
    files.push(file);
  }
  return Object.freeze(files.map((file) => Object.freeze(file)));
}

export function taskTreeDigest(files: readonly TaskFile[]): Sha256Digest {
  return digestCanonicalJson([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Only used with a fresh host-owned directory, never an Agent's writable tree. */
export async function materializeTaskFiles(root: string, files: readonly TaskFile[]): Promise<void> {
  for (const file of files) {
    LocalTaskPathSchema.parse(file.path);
    const bytes = Buffer.from(file.contentBase64, 'base64');
    if (bytes.toString('base64') !== file.contentBase64 || fileDigest(bytes) !== file.digest) throw new Error('TASK_FILE_DIGEST_INVALID');
    const destination = join(root, file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: 'wx', mode: file.executable ? 0o700 : 0o600 });
  }
}

export async function collectTaskArtifacts(input: {
  root: string; paths: readonly string[]; maxBytes: number; snapshot: readonly TaskFile[];
}): Promise<Pick<LocalTaskOutput, 'files' | 'missing' | 'collectionErrors'>> {
  const result: Pick<LocalTaskOutput, 'files' | 'missing' | 'collectionErrors'> = { files: [], missing: [], collectionErrors: [] };
  let remaining = input.maxBytes;
  for (const path of [...input.paths].sort()) {
    try {
      const file = await readTaskFile(input.root, path, remaining);
      remaining -= Buffer.from(file.contentBase64, 'base64').length;
      const before = input.snapshot.find((entry) => entry.path === path);
      result.files.push({ ...file, change: before === undefined ? 'added' : before.digest === file.digest && before.executable === file.executable ? 'unchanged' : 'modified' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') result.missing.push(path);
      else result.collectionErrors.push({ path, code: error instanceof Error && error.message === 'TASK_FILE_LIMIT' ? 'TASK_FILE_LIMIT' : 'TASK_COLLECTION_FAILED' });
    }
  }
  return result;
}
