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
import { existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createFileStore } from './report-store.js';
import { artifactIndexDir, listReportCards, listLiveReportCards, cardToReportDocument, removeReportCard, cardTargetSentinel } from '../eval-core/artifact-index.js';
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

  // 卡片扫描的指纹缓存:目录 mtime + 每张卡片(名:mtime:size)三元组 —— 与 createFileStore 同口径(report-store.ts:79)。
  // 仅用目录 mtime 不够:同毫秒内改卡片内容 / mtime 精度问题会漏失效、发陈旧;三元组到单文件粒度,内容一变即失效。
  // live 两源各自带 report-store 的指纹缓存,这里只缓存卡片层。
  let cachedFp = '';
  let cachedCards: ReportDocument[] | null = null;
  function cardFingerprint(): string {
    const dir = artifactIndexDir('report');
    try {
      if (!existsSync(dir)) return 'none';
      const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('.json.tmp.')).sort();
      const parts = files.map((f) => {
        try { const s = statSync(join(dir, f)); return `${f}:${s.mtimeMs}:${s.size}`; } catch { return `${f}:?`; }
      });
      // 真身存在性也进指纹:否则真身被带外删、卡片 JSON 没变,缓存命中会继续展示已悬空卡片。
      return `${statSync(dir).mtimeMs}|${parts.join(',')}|t:${cardTargetSentinel('report')}`;
    } catch {
      return 'none';
    }
  }
  function cardDocs(): ReportDocument[] {
    const fp = cardFingerprint();
    if (fp === cachedFp && cachedCards) return cachedCards;
    // 机器级 list 展示用 live 卡片:真身被带外删/移走的悬空卡片不进列表(把卡片当活指针)。
    // get() 仍走 raw listReportCards 做 by-id best-effort(直链命中真身则给真身、悬空降级壳)。
    const docs = listLiveReportCards().map(cardToReportDocument);
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
    // 三处各自删、不能短路:同一 id 可能在项目与全局都有副本(旧数据迁移期最常见),
    // 用 `||` 会在删掉项目那份后短路、漏删全局那份,下次 list 全局同 id 又浮出来(DELETE 返 200 但 id 复活)。
    const projectRemoved = await project.remove(id);
    const globalRemoved = await global.remove(id);
    const cardRemoved = removeReportCard(id);
    // 真身在别项目删不到,但删卡片即让它从机器级 list 消失。返回契约刻意是「是否从本机器级视图移除成功」
    // (= 删了真身或删了卡片),而非「删了正文真身」—— studio DELETE 的语义是「从我的总览拿掉这条」,
    // 别项目正文留在它自己项目里不受影响。
    return projectRemoved || globalRemoved || cardRemoved;
  }

  async function findByVariant(variantName: string): Promise<EvaluationReport[]> {
    return (await list()).filter(isEvaluation).filter((r) => r.meta?.variants?.includes(variantName));
  }

  async function findByArtifactHash(hash: string): Promise<EvaluationReport[]> {
    return (await list()).filter(isEvaluation).filter((r) => Object.values(r.meta?.artifactHashes || {}).includes(hash));
  }

  return { list, get, save, update, remove, exists, findByVariant, findByArtifactHash };
}
