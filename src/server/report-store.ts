/**
 * Report storage abstraction.
 * Default implementation: local file system.
 * Can be replaced with database, S3, etc.
 */

import { readdir, readFile, writeFile, unlink, access, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchEvaluationReport, EvaluationJob, EvaluationReport, JobStore, ReportDocument, ReportMeta, ReportStore, VariantSummary } from '../types/index.js';

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

  function normalizeReportDocument(data: unknown, fallbackId: string): ReportDocument | null {
    if (!data || typeof data !== 'object') return null;
    const record = data as Record<string, unknown>;
    const kind = record.kind === 'evaluation' || record.kind === 'batch-evaluation'
      ? record.kind
      : undefined;
    if (kind === 'evaluation') {
      if (!record.meta || !record.summary || !Array.isArray(record.results)) return null;
      return {
        ...record,
        kind,
        id: typeof record.id === 'string' && record.id ? record.id : fallbackId,
      } as unknown as ReportDocument;
    }
    if (kind === 'batch-evaluation') {
      if (!record.meta || !Array.isArray(record.items)) return null;
      return {
        ...record,
        kind,
        id: typeof record.id === 'string' && record.id ? record.id : fallbackId,
      } as unknown as ReportDocument;
    }
    // 只认 canonical 顶层 `kind`(evaluation / batch-evaluation)。不再为旧格式(无判别字段 / 旧
    // reportKind)做读兼容 —— 顶层 kind cutover 是硬切换,旧文件直接判脏丢弃。
    return null;
  }

  function isEvaluationReport(report: ReportDocument): report is EvaluationReport {
    return report.kind === 'evaluation';
  }

  // Studio 每个 / 和 /skills/<name> 请求都调 list(),里面对每个 .json 同步 readFile +
  // JSON.parse。报告数上来后这是主性能瓶颈。缓存策略:fingerprint = dir mtime + 文件名
  // 排序串 + 每个文件 mtime;任一变化 invalidate。fingerprint 算 cheap(只 stat),命中后
  // 完全跳过 readFile。
  let cachedFingerprint = '';
  let cachedRuns: ReportDocument[] | null = null;
  async function computeListFingerprint(): Promise<string | null> {
    try {
      const dirStat = await stat(dir);
      const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
      const parts = await Promise.all(files.map(async (f) => {
        try {
          const s = await stat(join(dir, f));
          return `${f}:${s.mtimeMs}:${s.size}`;
        } catch { return `${f}:?`; }
      }));
      return `${dirStat.mtimeMs}|${parts.join(',')}`;
    } catch { return null; }
  }

  async function list(): Promise<ReportDocument[]> {
    try {
      await access(dir);
    } catch {
      return [];
    }
    const fp = await computeListFingerprint();
    if (fp != null && fp === cachedFingerprint && cachedRuns) return cachedRuns;

    const files = (await readdir(dir))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();
    const runs: ReportDocument[] = [];
    for (const file of files) {
      try {
        const data = JSON.parse(await readFile(join(dir, file), 'utf-8'));
        const report = normalizeReportDocument(data, file.replace(/\.json$/, ''));
        if (report) runs.push(report);
      } catch { /* skip corrupt files */ }
    }
    runs.sort((a, b) => {
      const ta = a.meta?.timestamp || '';
      const tb = b.meta?.timestamp || '';
      return tb.localeCompare(ta);
    });
    if (fp != null) {
      cachedFingerprint = fp;
      cachedRuns = runs;
    }
    return runs;
  }

  async function get(id: string): Promise<ReportDocument | null> {
    try {
      const data = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf-8'));
      return normalizeReportDocument(data, id);
    } catch {
      return null;
    }
  }

  async function save(id: string, report: ReportDocument): Promise<void> {
    await ensureDir();
    const tmpPath = join(dir, `${id}.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`);
    await writeFile(tmpPath, JSON.stringify(report, null, 2));
    await rename(tmpPath, join(dir, `${id}.json`));
  }

  /**
   * Atomic read-modify-write with in-memory mutex.
   * Prevents concurrent updates from overwriting each other.
   */
  async function update(id: string, mutator: (report: ReportDocument) => void): Promise<ReportDocument | null> {
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

  async function findByVariant(variantName: string): Promise<EvaluationReport[]> {
    const all = await list();
    return all.filter(isEvaluationReport).filter((r) => r.meta?.variants?.includes(variantName));
  }

  async function findByArtifactHash(hash: string): Promise<EvaluationReport[]> {
    const all = await list();
    return all.filter(isEvaluationReport).filter((r) => {
      const hashes = r.meta?.artifactHashes || {};
      return Object.values(hashes).includes(hash);
    });
  }

  return { list, get, save, update, remove, exists, findByVariant, findByArtifactHash };
}

export interface JobQuery {
  status?: string;
  reportId?: string;
  project?: string;
  owner?: string;
  tag?: string;
  limit?: number;
}

export async function queryJobList(jobStore: JobStore, query: JobQuery = {}): Promise<EvaluationJob[]> {
  let jobs = await jobStore.list();

  if (query.status) {
    jobs = jobs.filter((job) => job.status === query.status);
  }
  if (query.reportId) {
    jobs = jobs.filter((job) => job.resultReportId === query.reportId);
  }
  if (query.project) {
    jobs = jobs.filter((job) => job.request.project === query.project);
  }
  if (query.owner) {
    jobs = jobs.filter((job) => job.request.owner === query.owner);
  }
  if (query.tag) {
    jobs = jobs.filter((job) => job.request.tags?.includes(query.tag!));
  }
  if (typeof query.limit === 'number' && Number.isFinite(query.limit) && query.limit >= 0) {
    jobs = jobs.slice(0, query.limit);
  }

  return jobs;
}

export async function queryJob(jobStore: JobStore, id: string): Promise<EvaluationJob | null> {
  return jobStore.get(id);
}

export interface RunListItem {
  id: string;
  kind: ReportDocument['kind'];
  meta: ReportDocument['meta'];
  summary?: EvaluationReport['summary'];
  items?: BatchEvaluationReport['items'];
}

export interface TrendPoint {
  reportId: string;
  timestamp: string;
  avgCompositeScore: number | null;
  avgNumTurns: number | null;
  avgCostPerSample: number | null;
  artifactHash: string | null;
  gitCommitShort: string | null;
  gitBranch: string | null;
}

export interface TrendQueryResult {
  variant: string;
  points: TrendPoint[];
  runs: EvaluationReport[];
}

export async function queryRunList(reportStore: ReportStore): Promise<RunListItem[]> {
  return (await reportStore.list()).map((report) => ({
    id: report.id,
    kind: report.kind,
    meta: report.meta,
    ...(report.kind === 'evaluation' ? { summary: report.summary } : { items: report.items }),
  }));
}

export async function queryRun(reportStore: ReportStore, id: string): Promise<ReportDocument | null> {
  return reportStore.get(id);
}

export async function queryTrend(reportStore: ReportStore, variantName: string): Promise<TrendQueryResult> {
  const runs = await reportStore.findByVariant(variantName);
  const points: TrendPoint[] = runs.map((report) => {
    const summary: Partial<VariantSummary> = report.summary?.[variantName] || {};
    const meta: ReportMeta = report.meta;
    return {
      reportId: report.id,
      timestamp: meta.timestamp,
      avgCompositeScore: summary.avgCompositeScore ?? null,
      avgNumTurns: summary.avgNumTurns ?? null,
      avgCostPerSample: summary.avgCostPerSample ?? null,
      artifactHash: meta.artifactHashes?.[variantName] || null,
      gitCommitShort: meta.gitInfo?.commitShort || null,
      gitBranch: meta.gitInfo?.branch || null,
    };
  });

  return {
    variant: variantName,
    points,
    runs,
  };
}
