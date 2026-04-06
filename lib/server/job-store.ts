import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { EvaluationJob, JobStore } from '../types.js';

export const DEFAULT_JOBS_DIR = join(homedir(), '.oh-my-knowledge', 'jobs');

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function createFileJobStore(dir: string): JobStore {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  async function list(): Promise<EvaluationJob[]> {
    const files = await listJsonFiles(dir);
    const jobs = await Promise.all(
      files.map(async (file) => JSON.parse(await fs.readFile(join(dir, file), 'utf-8')) as EvaluationJob),
    );
    return jobs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  async function get(id: string): Promise<EvaluationJob | null> {
    try {
      return JSON.parse(await fs.readFile(join(dir, `${id}.json`), 'utf-8')) as EvaluationJob;
    } catch {
      return null;
    }
  }

  async function save(id: string, job: EvaluationJob): Promise<void> {
    await fs.writeFile(join(dir, `${id}.json`), JSON.stringify(job, null, 2));
  }

  async function update(id: string, mutator: (job: EvaluationJob) => EvaluationJob): Promise<EvaluationJob | null> {
    const current = await get(id);
    if (!current) return null;
    const updated = mutator(current);
    await save(id, updated);
    return updated;
  }

  async function remove(id: string): Promise<boolean> {
    try {
      await fs.unlink(join(dir, `${id}.json`));
      return true;
    } catch (err: unknown) {
      const fsError = err as NodeJS.ErrnoException;
      if (fsError.code === 'ENOENT') return false;
      throw err;
    }
  }

  async function exists(id: string): Promise<boolean> {
    try {
      await fs.access(join(dir, `${id}.json`));
      return true;
    } catch {
      return false;
    }
  }

  return { list, get, save, update, remove, exists };
}
