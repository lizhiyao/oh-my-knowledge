/**
 * Report storage abstraction.
 * Default implementation: local file system.
 * Can be replaced with database, S3, etc.
 */

import { readdir, readFile, writeFile, unlink, access, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isReportFileName, reportFilePath, reportFileStem } from '../eval-core/artifact-file-names.js';
import type { EvaluationJob, EvaluationReport, JobStore, ReportDocument, ReportIndexCard, ReportMeta, ReportStore, VariantSummary } from '../types/index.js';

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
    // 只认 canonical 顶层 `kind`(evaluation / batch-evaluation)。不再为旧格式(顶层无该判别字段的
    // 历史文件)做读兼容 —— 顶层 kind cutover 是硬切换,旧文件直接判脏丢弃。
    return null;
  }

  function isEvaluationReport(report: ReportDocument): report is EvaluationReport {
    return report.kind === 'evaluation';
  }

  // Studio 每个 / 和 /skills/<name> 请求都调 list(),里面对每个 .report.json 同步 readFile +
  // JSON.parse。报告数上来后这是主性能瓶颈。缓存策略:fingerprint = dir mtime + 文件名
  // 排序串 + 每个文件 mtime;任一变化 invalidate。fingerprint 算 cheap(只 stat),命中后
  // 完全跳过 readFile。
  let cachedFingerprint = '';
  let cachedRuns: ReportDocument[] | null = null;
  async function computeListFingerprint(): Promise<string | null> {
    try {
      const dirStat = await stat(dir);
      const files = (await readdir(dir)).filter(isReportFileName).sort();
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
      .filter(isReportFileName)
      .sort()
      .reverse();
    const runs: ReportDocument[] = [];
    for (const file of files) {
      try {
        const data = JSON.parse(await readFile(join(dir, file), 'utf-8'));
        const report = normalizeReportDocument(data, reportFileStem(file) ?? file);
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
      const data = JSON.parse(await readFile(reportFilePath(dir, id), 'utf-8'));
      return normalizeReportDocument(data, id);
    } catch {
      return null;
    }
  }

  async function save(id: string, report: ReportDocument): Promise<void> {
    await ensureDir();
    const targetPath = reportFilePath(dir, id);
    const tmpPath = `${targetPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    await writeFile(tmpPath, JSON.stringify(report, null, 2));
    await rename(tmpPath, targetPath);
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
      await unlink(reportFilePath(dir, id));
      return true;
    } catch (err: unknown) {
      const fsError = err as NodeJS.ErrnoException;
      if (fsError.code === 'ENOENT') return false;
      throw err;
    }
  }

  async function exists(id: string): Promise<boolean> {
    try {
      await access(reportFilePath(dir, id));
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

/**
 * 项目盖全局的 overlay 报告存储。reports 默认落项目 `.omk/reports`(绑用例集,construct validity),
 * 全局 `~/.oh-my-knowledge/reports` 作存量兜底。两类语义刻意不同:
 *   - 浏览(list / findByVariant):记录优先 —— 项目有报告只看项目(studio 不混进跨项目全局堆),
 *     项目空才回退全局(空项目不白屏)。同 resolveManagedDir / phase-1 口径。
 *   - 寻址(get / exists / findByArtifactHash):项目→全局兜底 —— 拿具体 id / 内容哈找文件时两处都查,
 *     resume / gold-compare / baseline 复用不因「写默认翻项目」而落空;复用查找继续覆盖全局,报告数字零变化。
 * 写(save / update / remove):落项目(写默认目标);update / remove 找不到再落/试全局(改删 studio 当前所见那份)。
 * 两个底层 createFileStore 各自带 list 指纹缓存,overlay 一次构建即可、无需每请求重建(cwd 进程内不变,
 * 内容变化由 createFileStore 的 mtime 指纹自动失效)。
 */
export function createOverlayReportStore(projectDir: string, globalDir: string): ReportStore {
  const project = createFileStore(projectDir);
  const global = createFileStore(globalDir);

  async function projectHasReports(): Promise<boolean> {
    return (await project.list()).length > 0;
  }

  async function list(): Promise<ReportDocument[]> {
    return (await projectHasReports()) ? project.list() : global.list();
  }

  async function get(id: string): Promise<ReportDocument | null> {
    return (await project.get(id)) ?? global.get(id);
  }

  async function exists(id: string): Promise<boolean> {
    return (await project.exists(id)) || global.exists(id);
  }

  async function save(id: string, report: ReportDocument): Promise<void> {
    return project.save(id, report);
  }

  async function update(id: string, mutator: (report: ReportDocument) => void): Promise<ReportDocument | null> {
    return (await project.exists(id)) ? project.update(id, mutator) : global.update(id, mutator);
  }

  async function remove(id: string): Promise<boolean> {
    return (await project.remove(id)) || global.remove(id);
  }

  async function findByVariant(variantName: string): Promise<EvaluationReport[]> {
    return (await projectHasReports()) ? project.findByVariant(variantName) : global.findByVariant(variantName);
  }

  async function findByArtifactHash(hash: string): Promise<EvaluationReport[]> {
    // 跨两处合并(项目优先 dedup):baseline 复用继续覆盖全局,保证复用命中率与报告数字不变。
    const [p, g] = await Promise.all([project.findByArtifactHash(hash), global.findByArtifactHash(hash)]);
    const seen = new Set(p.map((r) => r.id));
    return [...p, ...g.filter((r) => !seen.has(r.id))];
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

// 与 ReportIndexCard(types/report.ts)同形,去掉 domain 判别与 path 寻址字段:索引卡片即「带寻址信息的
// RunListItem」,两边共用一处形状定义,避免字段漂移。
export type RunListItem = Omit<ReportIndexCard, 'domain' | 'path'>;

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
