/**
 * 机器级总览报告存储:让 `omk studio` 跨项目聚合所有报告。
 *
 * 三数据源合并、按 id dedup(live 盖卡片,优先级 项目 > 全局 > 卡片):
 *   - live(当前项目 `.omk/reports`) + live(全局 `~/.oh-my-knowledge/reports`):完整真身,永远新鲜(无需 backfill);
 *   - 索引卡片(state/artifact-index/report/):覆盖**别的项目**的报告(当前 studio 的 cwd live 扫不到),
 *     卡片只含 meta+summary(无 results),详情按 `card.path` 读真身。
 *
 * 与 createOverlayReportStore(项目盖全局、记录优先)的区别:这里是**机器级 merge**(看全本机),不是项目优先;
 * 可比性红线在比较层(verdict / findByVariant 锁同口径)而非视图层,故跨项目 merge 列表合法。
 * by-id 复用 / resume / gold-compare 仍走 overlay(当前项目→全局),不走本 store —— 索引只供 studio 浏览。
 */
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createFileStore } from './report-store.js';
import { artifactIndexDir, listReportCards, cardToReportDocument, removeReportCard } from '../eval-core/artifact-index.js';
import type { ReportDocument, ReportStore, EvaluationReport } from '../types/index.js';

function isEvaluation(r: ReportDocument): r is EvaluationReport {
  return r.kind === 'evaluation';
}

export interface IndexedReportStoreOptions {
  /** 当前项目 reports 目录(随 studio 进程 cwd 固定)。 */
  projectDir: string;
  /** 全局 reports 目录。 */
  globalDir: string;
}

export function createIndexedReportStore({ projectDir, globalDir }: IndexedReportStoreOptions): ReportStore {
  const project = createFileStore(projectDir);
  const global = createFileStore(globalDir);

  // 卡片扫描的轻量指纹缓存:索引目录 mtime + 条目数变化即失效(卡片 tmp+rename 写入会动目录 mtime)。
  // live 两源各自带 report-store 的指纹缓存,这里只缓存卡片层。
  let cachedFp = '';
  let cachedCards: ReportDocument[] | null = null;
  function cardDocs(): ReportDocument[] {
    const dir = artifactIndexDir('report');
    let fp = 'none';
    try {
      if (existsSync(dir)) fp = `${statSync(dir).mtimeMs}`;
    } catch { /* fall through */ }
    if (fp === cachedFp && cachedCards) return cachedCards;
    const docs = listReportCards().map(cardToReportDocument);
    cachedFp = fp;
    cachedCards = docs;
    return docs;
  }

  async function list(): Promise<ReportDocument[]> {
    const [proj, glob] = await Promise.all([project.list(), global.list()]);
    const seen = new Set<string>();
    const merged: ReportDocument[] = [];
    for (const r of proj) { if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); } }
    for (const r of glob) { if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); } }
    for (const r of cardDocs()) { if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); } }
    merged.sort((a, b) => (b.meta?.timestamp || '').localeCompare(a.meta?.timestamp || ''));
    return merged;
  }

  async function get(id: string): Promise<ReportDocument | null> {
    // 先 live(当前项目→全局),命中即完整真身。
    const live = (await project.get(id)) ?? (await global.get(id));
    if (live) return live;
    // 别项目:按卡片 path 读真身;悬空(项目被移动/删除)→ 返回卡片壳(results:[])不抛、不 500。
    const card = listReportCards().find((c) => c.id === id);
    if (!card) return null;
    const fromFile = await createFileStore(dirname(card.path)).get(id);
    return fromFile ?? cardToReportDocument(card);
  }

  async function exists(id: string): Promise<boolean> {
    if (await project.exists(id)) return true;
    if (await global.exists(id)) return true;
    return listReportCards().some((c) => c.id === id);
  }

  async function save(id: string, report: ReportDocument): Promise<void> {
    return project.save(id, report);
  }

  async function update(id: string, mutator: (report: ReportDocument) => void): Promise<ReportDocument | null> {
    // 只改 live 真身(卡片是只读指针);别项目真身不在本机可写范围。
    return (await project.exists(id)) ? project.update(id, mutator) : global.update(id, mutator);
  }

  async function remove(id: string): Promise<boolean> {
    const liveRemoved = (await project.remove(id)) || (await global.remove(id));
    // 真身可能在别项目删不到,但删卡片即让它从机器级 list 消失(达成「从总览移除」意图)。
    const cardRemoved = removeReportCard(id);
    return liveRemoved || cardRemoved;
  }

  async function findByVariant(variantName: string): Promise<EvaluationReport[]> {
    return (await list()).filter(isEvaluation).filter((r) => r.meta?.variants?.includes(variantName));
  }

  async function findByArtifactHash(hash: string): Promise<EvaluationReport[]> {
    return (await list()).filter(isEvaluation).filter((r) => Object.values(r.meta?.artifactHashes || {}).includes(hash));
  }

  return { list, get, save, update, remove, exists, findByVariant, findByArtifactHash };
}
