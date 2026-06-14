/**
 * 产物发现索引(report / doctor / observe-health 三域)。
 *
 * 每类测量产物的正文(含逐样本 / 逐规则 / 逐信号重体)永远单份留它的项目本地 `.omk/<域>/`;产物落盘后,
 * 在全局 `state/artifact-index/<域>/<id>.json` 留一张轻卡片(元数据 + 必要标量,剥掉重体,`path` 指向真身),
 * 让 `omk studio` 跨项目聚合成「机器级总览」—— 当前项目 + 全局靠 live-scan 永远新鲜,别的项目靠卡片发现。
 *
 * 索引是可重生 scratch:写失败永不阻断正文落盘(正文是 source of truth);丢了由 live-scan / 重跑重建。
 * 三域共用 `artifactIndexDir(domain)` + tmp-rename 原子写 + 指纹缓存读 的同一套机制,各域只差「投影成卡片」
 * 与「卡片还原成 snapshot」两段域特定逻辑。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_ARTIFACT_INDEX_DIR } from './default-dirs.js';
import { globalReportsDir, globalDoctorsDir, globalObserveHealthDir } from './measurement-dirs.js';
import type { BatchEvaluationReport, EvaluationReport, ReportDocument, ReportIndexCard } from '../types/index.js';
import type { SkillDoctorSnapshot } from '../types/skill-index.js';
import type { DoctorSkillStatus } from '../types/doctor.js';

export type ArtifactDomain = 'report' | 'doctor' | 'observe-health';

// ── 通用机制(域无关)──────────────────────────────────────────────────────────

/** 索引根:`OMK_ARTIFACT_INDEX_DIR` 覆盖(测试隔离,仿 OMK_TREES_DIR),默认 state/artifact-index。 */
function artifactIndexRoot(): string {
  return process.env.OMK_ARTIFACT_INDEX_DIR || DEFAULT_ARTIFACT_INDEX_DIR;
}

/** 某域的索引目录 `<root>/<domain>/`。 */
export function artifactIndexDir(domain: ArtifactDomain): string {
  return join(artifactIndexRoot(), domain);
}

/** 只索引「非全局目录」的写:全局是单一物理目录、任何 studio 都 live-scan 它 → 全局写卡片冗余;
 *  卡片唯一价值是别项目的项目级 `.omk/<域>`。 */
function shouldIndexDir(outputDir: string, globalDir: string): boolean {
  return resolve(outputDir) !== resolve(globalDir);
}

/** report 域口径(保持向后兼容的既有导出)。 */
export function shouldIndexReport(outputDir: string): boolean {
  return shouldIndexDir(outputDir, globalReportsDir());
}

function safeFileName(id: string): string {
  return id.replaceAll(/[/\\:*?"<>|]/g, '_');
}

// 卡片读侧小 guard:索引是可重生 scratch,坏卡片(脏文件 / 别域误落 / 字段缺失)读侧从严跳过,
// 不让 undefined / 非法枚举 / NaN 当可信输入污染 studio。
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isDoctorStatus = (v: unknown): v is DoctorSkillStatus => v === 'pass' || v === 'warn' || v === 'fail';
const isHealthBand = (v: unknown): v is 'green' | 'yellow' | 'red' => v === 'green' || v === 'yellow' || v === 'red';
const isConfidence = (v: unknown): boolean => v === undefined || v === 'high' || v === 'low' || v === 'underpowered';

/** 原子写一张卡片(tmp+rename,防半截 JSON 被 reader 读到)。 */
function writeCard(domain: ArtifactDomain, id: string, card: object): void {
  const indexDir = artifactIndexDir(domain);
  mkdirSync(indexDir, { recursive: true });
  const target = join(indexDir, `${safeFileName(id)}.json`);
  const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(card, null, 2));
  renameSync(tmp, target);
}

/** 读某域全部卡片,逐条用 `valid` 谓词过滤坏文件 / 缺字段(索引是 scratch,读侧从严)。 */
function readArtifactCards<T>(domain: ArtifactDomain, valid: (c: unknown) => c is T): T[] {
  const dir = artifactIndexDir(domain);
  if (!existsSync(dir)) return [];
  let files: string[];
  try { files = readdirSync(dir); } catch { return []; }
  const out: T[] = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.includes('.json.tmp.')) continue;
    try {
      const c: unknown = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      if (valid(c)) out.push(c);
    } catch { /* skip corrupt card */ }
  }
  return out;
}

/** 删某域某 id 的卡片。幂等、best-effort。返回卡片是否曾存在。 */
function removeArtifactCard(domain: ArtifactDomain, id: string): boolean {
  try {
    const p = join(artifactIndexDir(domain), `${safeFileName(id)}.json`);
    if (!existsSync(p)) return false;
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 过滤悬空卡片:真身文件(`card.path`)已不在(项目被整目录删 / 移走等带外途径)→ 卡片视为「指向不存在的产物」。
 * 机器级 list / merge 展示路径用 listLive*Cards,不展示这类卡片(把卡片当活指针,而非持久记录)。
 * 注:by-id 的 get / loadXReport 兜底仍走 raw list*Cards —— 直链书签按 card.path 读到则给真身、读不到各自降级,
 * 是 best-effort,不在这层过滤。doctor 历史 prune 已连带删卡片,故悬空主要发生在「带外删整个项目目录」。
 */
function liveCards<T extends { path: string }>(cards: T[]): T[] {
  return cards.filter((c) => existsSync(c.path));
}

/**
 * 某域所有卡片「真身(card.path)」的存在性 + mtime/size 指纹。
 * 消费方(indexed-report-store / buildSkillIndex)的缓存指纹必须纳入它:卡片 JSON 本身没变、只靠卡片目录
 * mtime 的指纹检测不到「真身被带外删」,长会话会继续命中旧缓存展示悬空卡片。真身删/改 → 此 sentinel 变 →
 * 缓存失效 → live 过滤生效。读卡片只为拿 path,字段宽松。
 */
export function cardTargetSentinel(domain: ArtifactDomain): string {
  const dir = artifactIndexDir(domain);
  if (!existsSync(dir)) return '';
  let files: string[];
  try { files = readdirSync(dir); } catch { return ''; }
  const parts: string[] = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.includes('.json.tmp.')) continue;
    try {
      const c = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as { path?: unknown };
      if (typeof c.path !== 'string') continue;
      try { const s = statSync(c.path); parts.push(`${f}=${s.mtimeMs}:${s.size}`); }
      catch { parts.push(`${f}=gone`); }
    } catch { /* skip corrupt */ }
  }
  return parts.sort().join(',');
}

// ── report 域 ───────────────────────────────────────────────────────────────

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
    writeCard('report', report.id, reportCard(doc as ReportDocument, sourcePath));
  } catch {
    // 索引可重建,失败静默(可选 stderr warn);正文已落盘不受影响。
  }
}

/** 读 report 域全部卡片(跳过坏文件 / 缺字段 / 坏 kind)。 */
export function listReportCards(): ReportIndexCard[] {
  return readArtifactCards('report', (c): c is ReportIndexCard => {
    const card = c as Partial<ReportIndexCard>;
    // kind 白名单:cardToReportDocument 对任何非 evaluation 一律按 batch 投影,坏 kind(拼错 / 'doctor')
    // 会污染机器级 list 成空 batch 报告。索引是可重生 scratch,读侧从严跳过坏卡片。
    const kindOk = card?.kind === 'evaluation' || card?.kind === 'batch-evaluation';
    return !!card && card.domain === 'report' && kindOk && typeof card.id === 'string' && typeof card.path === 'string' && !!card.meta;
  });
}

/** report 卡片(过滤悬空真身):供 studio 机器级 list / findBy 展示。 */
export function listLiveReportCards(): ReportIndexCard[] {
  return liveCards(listReportCards());
}

/** 卡片 → ReportDocument(results:[]):供 studio list / buildSkillIndex / trend 消费(它们不读 results)。 */
export function cardToReportDocument(card: ReportIndexCard): ReportDocument {
  return card.kind === 'evaluation'
    ? { kind: 'evaluation', id: card.id, meta: card.meta as EvaluationReport['meta'], summary: card.summary ?? {}, results: [] }
    : { kind: 'batch-evaluation', id: card.id, mode: 'skill', meta: card.meta as BatchEvaluationReport['meta'], items: card.items ?? [] };
}

/** 删 report 域某 id 的卡片(DELETE 报告时连卡片一起删,使其从机器级 list 消失)。幂等、best-effort。 */
export function removeReportCard(id: string): boolean {
  return removeArtifactCard('report', id);
}

// ── doctor 域 ───────────────────────────────────────────────────────────────

/** doctor 卡片:per-skill 文件(`{skillName}-{reportId}.json`)一张。id = 文件名 stem(唯一),
 *  reportId = 该次 doctor run 的 id(同 run 多 skill 共享)。剥掉逐规则 results 重体,只留 per-skill 计数。
 *  无 `kind` 字段 —— domain 已足够判别(doctor 只有一种报告 kind)。 */
export interface DoctorIndexCard {
  domain: 'doctor';
  id: string;
  path: string;
  skillName: string;
  reportId: string;
  timestamp: string;
  status: DoctorSkillStatus;
  passCount: number;
  warnCount: number;
  failCount: number;
}

/** persistDoctorReport per-skill 循环里的索引钩子。best-effort,永不抛、永不阻断正文落盘。 */
export function indexDoctorWrite(card: Omit<DoctorIndexCard, 'domain'>, outputDir: string): void {
  try {
    if (!shouldIndexDir(outputDir, globalDoctorsDir())) return;
    writeCard('doctor', card.id, { domain: 'doctor', ...card } satisfies DoctorIndexCard);
  } catch { /* 索引可重建,失败静默 */ }
}

/** 读 doctor 域全部卡片。 */
export function listDoctorCards(): DoctorIndexCard[] {
  return readArtifactCards('doctor', (c): c is DoctorIndexCard => {
    const card = c as Partial<DoctorIndexCard>;
    return !!card && card.domain === 'doctor' && typeof card.id === 'string' && typeof card.path === 'string'
      && typeof card.skillName === 'string' && typeof card.reportId === 'string' && typeof card.timestamp === 'string'
      && isDoctorStatus(card.status)
      && isFiniteNumber(card.passCount) && isFiniteNumber(card.warnCount) && isFiniteNumber(card.failCount);
  });
}

/** doctor 卡片(过滤悬空真身):供 buildSkillIndex 机器级合并。 */
export function listLiveDoctorCards(): DoctorIndexCard[] {
  return liveCards(listDoctorCards());
}

/** doctor 卡片 → (skillName, SkillDoctorSnapshot)。results:[](逐规则详情需回源项目看)。 */
export function cardToDoctorSnapshot(card: DoctorIndexCard): { skillName: string; snap: SkillDoctorSnapshot } {
  return {
    skillName: card.skillName,
    snap: {
      reportId: card.reportId, timestamp: card.timestamp, status: card.status,
      passCount: card.passCount, warnCount: card.warnCount, failCount: card.failCount, results: [],
    },
  };
}

/** 删 doctor 域某 id(文件 stem)的卡片。doctor 历史按 50/skill prune,删正文时必须连卡片一起删,
 *  否则被 prune 掉的报告会经卡片合并在本项目 studio「复活」。 */
export function removeDoctorCard(id: string): boolean {
  return removeArtifactCard('doctor', id);
}

// ── observe-health 域 ─────────────────────────────────────────────────────────

/** observe 报告投影到卡片所需的结构子集(不 import observability/SkillHealthReport,保持 eval-core 解耦)。 */
interface ObserveCardSkill {
  toolFailureRate: number;
  segmentCount: number;
  gap?: { weightedGapRate?: number };
  confidence?: 'high' | 'low' | 'underpowered';
}
interface ObserveSource {
  meta: { generatedAt: string; sessionCount: number; segmentCount: number };
  overall: { healthBand: 'green' | 'yellow' | 'red'; confidence?: 'high' | 'low' | 'underpowered' };
  bySkill: Record<string, ObserveCardSkill>;
}

/** observe 卡片:每份报告一张。id = 文件名 stem。剥掉每个 skill 的 gap.signals 等重体,只留 list / skill-index
 *  口径需要的标量(meta 摘要 + overall + per-skill 标量)。详情(含 signals)走 card.path 读真身。无 `kind` 字段。 */
export interface ObserveIndexCard {
  domain: 'observe-health';
  id: string;
  path: string;
  meta: { generatedAt: string; sessionCount: number; segmentCount: number };
  overall: { healthBand: 'green' | 'yellow' | 'red'; confidence?: 'high' | 'low' | 'underpowered' };
  bySkill: Record<string, ObserveCardSkill>;
}

/** persistObserveHealthReport 的索引钩子。best-effort,永不抛、永不阻断正文落盘。 */
export function indexObserveWrite(report: ObserveSource, sourcePath: string, outputDir: string, id: string): void {
  try {
    if (!shouldIndexDir(outputDir, globalObserveHealthDir())) return;
    const bySkill: Record<string, ObserveCardSkill> = {};
    for (const [name, h] of Object.entries(report.bySkill || {})) {
      bySkill[name] = {
        toolFailureRate: h.toolFailureRate, segmentCount: h.segmentCount,
        gap: { weightedGapRate: h.gap?.weightedGapRate ?? 0 }, confidence: h.confidence,
      };
    }
    const card: ObserveIndexCard = {
      domain: 'observe-health', id, path: sourcePath,
      meta: { generatedAt: report.meta.generatedAt, sessionCount: report.meta.sessionCount, segmentCount: report.meta.segmentCount },
      overall: { healthBand: report.overall.healthBand, confidence: report.overall.confidence },
      bySkill,
    };
    writeCard('observe-health', id, card);
  } catch { /* 索引可重建,失败静默 */ }
}

/** 读 observe-health 域全部卡片。 */
export function listObserveCards(): ObserveIndexCard[] {
  return readArtifactCards('observe-health', (c): c is ObserveIndexCard => {
    const card = c as Partial<ObserveIndexCard>;
    if (!card || card.domain !== 'observe-health' || typeof card.id !== 'string' || typeof card.path !== 'string') return false;
    const meta = card.meta; const overall = card.overall; const bySkill = card.bySkill;
    if (!meta || !isFiniteNumber(meta.sessionCount) || !isFiniteNumber(meta.segmentCount) || typeof meta.generatedAt !== 'string') return false;
    if (!overall || !isHealthBand(overall.healthBand) || !isConfidence(overall.confidence)) return false;
    if (!bySkill || typeof bySkill !== 'object') return false;
    // 每个 skill 的标量也校验:坏 toolFailureRate / segmentCount / gap.weightedGapRate 会让 bandFromObserveHealth /
    // 趋势 / 健康快照出 NaN(buildSkillIndex 直接取 h.gap?.weightedGapRate ?? 0 进 gapRate、参与阈值判断)。
    for (const h of Object.values(bySkill)) {
      if (!h || !isFiniteNumber(h.toolFailureRate) || !isFiniteNumber(h.segmentCount) || !isConfidence(h.confidence)) return false;
      if (h.gap !== undefined && h.gap.weightedGapRate !== undefined && !isFiniteNumber(h.gap.weightedGapRate)) return false;
    }
    return true;
  });
}

/** observe 卡片(过滤悬空真身):供 listAnalyses / buildSkillIndex 机器级合并。 */
export function listLiveObserveCards(): ObserveIndexCard[] {
  return liveCards(listObserveCards());
}

/** 删 observe 域某 id 的卡片。 */
export function removeObserveCard(id: string): boolean {
  return removeArtifactCard('observe-health', id);
}
