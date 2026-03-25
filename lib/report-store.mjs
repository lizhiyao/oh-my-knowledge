/**
 * Report storage abstraction.
 * Default implementation: local file system.
 * Can be replaced with database, S3, etc.
 */

import { readdir, readFile, writeFile, unlink, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * @typedef {Object} ReportStore
 * @property {() => Promise<Array>} list - List all reports (summary only)
 * @property {(id: string) => Promise<Object|null>} get - Get a report by ID
 * @property {(id: string, report: Object) => Promise<void>} save - Save/update a report
 * @property {(id: string) => Promise<boolean>} remove - Delete a report, returns true if existed
 * @property {(id: string) => Promise<boolean>} exists - Check if report exists
 */

/**
 * Create a file-system-based report store.
 *
 * @param {string} dir - Directory to store report JSON files
 * @returns {ReportStore}
 */
export function createFileStore(dir) {
  async function ensureDir() {
    try {
      await access(dir);
    } catch {
      await mkdir(dir, { recursive: true });
    }
  }

  async function list() {
    try {
      await access(dir);
    } catch {
      return [];
    }
    const files = (await readdir(dir))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();
    const runs = [];
    for (const file of files) {
      try {
        const data = JSON.parse(await readFile(join(dir, file), 'utf-8'));
        if (data && data.meta) {
          if (!data.id) data.id = file.replace(/\.json$/, '');
          runs.push(data);
        }
      } catch { /* skip corrupt files */ }
    }
    return runs;
  }

  async function get(id) {
    try {
      const data = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf-8'));
      if (!data.id) data.id = id;
      return data;
    } catch {
      return null;
    }
  }

  async function save(id, report) {
    await ensureDir();
    const tmpPath = join(dir, `${id}.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`);
    await writeFile(tmpPath, JSON.stringify(report, null, 2));
    const { rename } = await import('node:fs/promises');
    await rename(tmpPath, join(dir, `${id}.json`));
  }

  async function remove(id) {
    try {
      await unlink(join(dir, `${id}.json`));
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  async function exists(id) {
    try {
      await access(join(dir, `${id}.json`));
      return true;
    } catch {
      return false;
    }
  }

  return { list, get, save, remove, exists };
}
