/**
 * Report storage abstraction.
 * Default implementation: local file system.
 * Can be replaced with database, S3, etc.
 */

import { readdir, readFile, writeFile, unlink, access, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Report, ReportStore } from './types.js';

// Per-id in-memory mutex for safe read-modify-write.
// Uses a queue to avoid the race window between checking and acquiring the lock.
const locks = new Map<string, Promise<void>>();

async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  // Chain onto any existing lock for this id, so requests are serialized
  const prev = locks.get(id) ?? Promise.resolve();
  let releaseLock!: () => void;
  const next = new Promise<void>((r) => { releaseLock = r; });
  locks.set(id, next);
  await prev;
  try {
    return await fn();
  } finally {
    locks.delete(id);
    releaseLock();
  }
}

/**
 * Create a file-system-based report store.
 */
export function createFileStore(dir: string): ReportStore {
  async function ensureDir(): Promise<void> {
    try {
      await access(dir);
    } catch {
      await mkdir(dir, { recursive: true });
    }
  }

  async function list(): Promise<Report[]> {
    try {
      await access(dir);
    } catch {
      return [];
    }
    const files = (await readdir(dir))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();
    const runs: Report[] = [];
    for (const file of files) {
      try {
        const data = JSON.parse(await readFile(join(dir, file), 'utf-8'));
        if (data && data.meta) {
          if (!data.id) data.id = file.replace(/\.json$/, '');
          runs.push(data);
        }
      } catch { /* skip corrupt files */ }
    }
    runs.sort((a, b) => {
      const ta = a.meta?.timestamp || '';
      const tb = b.meta?.timestamp || '';
      return tb.localeCompare(ta);
    });
    return runs;
  }

  async function get(id: string): Promise<Report | null> {
    try {
      const data = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf-8'));
      if (!data.id) data.id = id;
      return data;
    } catch {
      return null;
    }
  }

  async function save(id: string, report: Report): Promise<void> {
    await ensureDir();
    const tmpPath = join(dir, `${id}.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`);
    await writeFile(tmpPath, JSON.stringify(report, null, 2));
    await rename(tmpPath, join(dir, `${id}.json`));
  }

  /**
   * Atomic read-modify-write with in-memory mutex.
   * Prevents concurrent updates from overwriting each other.
   */
  async function update(id: string, mutator: (report: Report) => void): Promise<Report | null> {
    return withLock(id, async () => {
      const report = await get(id);
      if (!report) return null;
      mutator(report);
      await save(id, report);
      return report;
    });
  }

  async function remove(id: string): Promise<boolean> {
    try {
      await unlink(join(dir, `${id}.json`));
      return true;
    } catch (err: unknown) {
      const fsError = err as NodeJS.ErrnoException;
      if (fsError.code === 'ENOENT') return false;
      throw err;
    }
  }

  async function exists(id: string): Promise<boolean> {
    try {
      await access(join(dir, `${id}.json`));
      return true;
    } catch {
      return false;
    }
  }

  async function findByVariant(variantName: string): Promise<Report[]> {
    const all = await list();
    return all.filter((r) => r.meta?.variants?.includes(variantName));
  }

  async function findByArtifactHash(hash: string): Promise<Report[]> {
    const all = await list();
    return all.filter((r) => {
      const hashes = r.meta?.artifactHashes || {};
      return Object.values(hashes).includes(hash);
    });
  }

  return { list, get, save, update, remove, exists, findByVariant, findByArtifactHash };
}
