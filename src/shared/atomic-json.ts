import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  linkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Publish JSON with a same-directory rename so readers never observe a partial file.
 */
export function writeJsonFileAtomic(path: string, value: unknown): void {
  publishJson(path, value, false);
}

/** Publish a new document without overwriting a file created by another writer. */
export function createJsonFileAtomic(path: string, value: unknown): void {
  publishJson(path, value, true);
}

function publishJson(path: string, value: unknown, exclusive: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2));
    if (exclusive) linkSync(tempPath, path);
    else renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}
