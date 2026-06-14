/**
 * 产物发现索引(report 域)。
 *
 * 报告正文(含 results 逐样本重体)永远单份留它的项目本地 `.omk/reports/<id>.json`;报告落盘后,在全局
 * `state/artifact-index/report/<id>.json` 留一张轻卡片(meta + summary,无 results,`path` 指向真身),
 * 让 `omk studio` 跨项目聚合成「机器级总览」—— 当前项目 + 全局靠 live-scan 永远新鲜,别的项目靠卡片发现。
 *
 * 索引是可重生 scratch:写失败永不阻断报告落盘(正文是 source of truth);丢了由 live-scan / 重跑重建。
 * doctor / observe-health 域后续复用 `artifactIndexDir(domain)` + tmp-rename 写卡片的同一套机制。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_ARTIFACT_INDEX_DIR } from './default-dirs.js';
import { globalReportsDir } from './measurement-dirs.js';
import type { BatchEvaluationReport, EvaluationReport, ReportDocument, ReportIndexCard } from '../types/index.js';

export type ArtifactDomain = 'report' | 'doctor' | 'observe-health';

/** 索引根:`OMK_ARTIFACT_INDEX_DIR` 覆盖(测试隔离,仿 OMK_TREES_DIR),默认 state/artifact-index。 */
function artifactIndexRoot(): string {
  return process.env.OMK_ARTIFACT_INDEX_DIR || DEFAULT_ARTIFACT_INDEX_DIR;
}

/** 某域的索引目录 `<root>/<domain>/`。 */
export function artifactIndexDir(domain: ArtifactDomain): string {
  return join(artifactIndexRoot(), domain);
}

/** 只索引「非全局目录」的写:全局是单一物理目录、任何 studio 都 live-scan 它 → 全局写卡片冗余;
 *  卡片唯一价值是别项目的项目级 `.omk/reports`。 */
export function shouldIndexReport(outputDir: string): boolean {
  return resolve(outputDir) !== resolve(globalReportsDir());
}

function safeFileName(id: string): string {
  return id.replaceAll(/[/\\:*?"<>|]/g, '_');
}

/** 原子写一张卡片(tmp+rename,防半截 JSON 被 reader 读到)。 */
function writeCard(indexDir: string, id: string, card: ReportIndexCard): void {
  mkdirSync(indexDir, { recursive: true });
  const target = join(indexDir, `${safeFileName(id)}.json`);
  const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(card, null, 2));
  renameSync(tmp, target);
}

/** 报告投影成卡片(剥掉 results 重体)。 */
function reportCard(report: ReportDocument, sourcePath: string): ReportIndexCard {
  return report.kind === 'evaluation'
    ? { domain: 'report', id: report.id, path: sourcePath, kind: 'evaluation', meta: report.meta, summary: report.summary }
    : { domain: 'report', id: report.id, path: sourcePath, kind: 'batch-evaluation', meta: report.meta, items: report.items };
}

/**
 * persistReport 的索引钩子:报告落盘后 best-effort 追加卡片。永不抛、永不阻断报告落盘。
 * 入参故意收 `{id}` 宽松(同 persistReport 的 PersistableReport):非完整报告(无 canonical kind)防御式跳过。
 */
export function indexReportWrite(report: { id: string }, sourcePath: string, outputDir: string): void {
  try {
    if (!shouldIndexReport(outputDir)) return;
    const doc = report as Partial<ReportDocument>;
    if (doc.kind !== 'evaluation' && doc.kind !== 'batch-evaluation') return;
    writeCard(artifactIndexDir('report'), report.id, reportCard(doc as ReportDocument, sourcePath));
  } catch {
    // 索引可重建,失败静默(可选 stderr warn);正文已落盘不受影响。
  }
}

/** 读 report 域全部卡片(跳过坏文件 / 缺字段)。 */
export function listReportCards(): ReportIndexCard[] {
  const dir = artifactIndexDir('report');
  if (!existsSync(dir)) return [];
  const cards: ReportIndexCard[] = [];
  let files: string[];
  try { files = readdirSync(dir); } catch { return []; }
  for (const f of files) {
    if (!f.endsWith('.json') || f.includes('.json.tmp.')) continue;
    try {
      const c = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as ReportIndexCard;
      // kind 白名单:cardToReportDocument 对任何非 evaluation 一律按 batch 投影,坏 kind(拼错 / 'doctor')
      // 会污染机器级 list 成空 batch 报告。索引是可重生 scratch,读侧从严跳过坏卡片。
      const kindOk = c?.kind === 'evaluation' || c?.kind === 'batch-evaluation';
      if (c && c.domain === 'report' && kindOk && typeof c.id === 'string' && typeof c.path === 'string' && c.meta) cards.push(c);
    } catch { /* skip corrupt card */ }
  }
  return cards;
}

/** 卡片 → ReportDocument(results:[]):供 studio list / buildSkillIndex / trend 消费(它们不读 results)。 */
export function cardToReportDocument(card: ReportIndexCard): ReportDocument {
  return card.kind === 'evaluation'
    ? { kind: 'evaluation', id: card.id, meta: card.meta as EvaluationReport['meta'], summary: card.summary ?? {}, results: [] }
    : { kind: 'batch-evaluation', id: card.id, mode: 'skill', meta: card.meta as BatchEvaluationReport['meta'], items: card.items ?? [] };
}

/** 删 report 域某 id 的卡片(DELETE 报告时连卡片一起删,使其从机器级 list 消失)。幂等、best-effort。
 *  返回卡片是否曾存在(供 remove 在「真身在别项目删不到、但卡片删了」时仍回报成功)。 */
export function removeReportCard(id: string): boolean {
  try {
    const p = join(artifactIndexDir('report'), `${safeFileName(id)}.json`);
    if (!existsSync(p)) return false;
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}
