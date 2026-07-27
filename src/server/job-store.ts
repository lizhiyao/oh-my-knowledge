import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFileAtomicAsync } from '../shared/atomic-json.js';
import {
  isSafeEvaluationJobId,
  isValidEvaluationJob,
} from '../shared/evaluation-job.js';
import { KeyedMutex } from '../shared/keyed-mutex.js';
import type { EvaluationJob, JobStore } from '../types/index.js';

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => {
        if (!entry.isFile() || !entry.name.endsWith('.json')) return false;
        return isSafeJobId(entry.name.slice(0, -'.json'.length));
      })
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function createFileJobStore(dir: string): JobStore {
  const mutations = new KeyedMutex();

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  async function list(): Promise<EvaluationJob[]> {
    const files = await listJsonFiles(dir);
    const jobs = (await Promise.all(files.map(async (file): Promise<EvaluationJob | null> => {
      const id = file.slice(0, -'.json'.length);
      try {
        return parseJob(await fs.readFile(join(dir, file), 'utf-8'), id);
      } catch {
        return null;
      }
    }))).filter((job): job is EvaluationJob => job !== null);
    return jobs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  async function get(id: string): Promise<EvaluationJob | null> {
    const path = jobFilePath(dir, id);
    if (!path) return null;
    try {
      return parseJob(await fs.readFile(path, 'utf-8'), id);
    } catch {
      return null;
    }
  }

  async function saveUnlocked(id: string, job: EvaluationJob): Promise<void> {
    const path = jobFilePath(dir, id);
    if (!path || !isValidEvaluationJob(job, id)) throw new Error('invalid job');
    await writeJsonFileAtomicAsync(path, job);
  }

  async function save(id: string, job: EvaluationJob): Promise<void> {
    await mutations.run(id, () => saveUnlocked(id, job));
  }

  async function update(id: string, mutator: (job: EvaluationJob) => EvaluationJob): Promise<EvaluationJob | null> {
    if (!isSafeJobId(id)) return null;
    return mutations.run(id, async () => {
      const current = await get(id);
      if (!current) return null;
      const updated = mutator(current);
      await saveUnlocked(id, updated);
      return updated;
    });
  }

  async function remove(id: string): Promise<boolean> {
    const path = jobFilePath(dir, id);
    if (!path) return false;
    return mutations.run(id, async () => {
      try {
        await fs.unlink(path);
        return true;
      } catch (err: unknown) {
        const fsError = err as NodeJS.ErrnoException;
        if (fsError.code === 'ENOENT') return false;
        throw err;
      }
    });
  }

  async function exists(id: string): Promise<boolean> {
    return (await get(id)) !== null;
  }

  return { list, get, save, update, remove, exists };
}

function isSafeJobId(id: string): boolean {
  return isSafeEvaluationJobId(id);
}

function jobFilePath(dir: string, id: string): string | null {
  return isSafeJobId(id) ? join(dir, `${id}.json`) : null;
}

function parseJob(raw: string, expectedId: string): EvaluationJob | null {
  const value = JSON.parse(raw) as unknown;
  return isValidEvaluationJob(value, expectedId) ? value : null;
}
