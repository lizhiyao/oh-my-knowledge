/**
 * 版本回归曲线的数据点构造(#236 Studio 决策史)。纯函数:report 由调用方按 evidence.reportId 读好传进来
 * (Map,值可为 null = 报告已清 / 读不到),把受管记录的逐版证据拼成按时间从旧到新的 composite + 95%CI 序列。
 *
 * 测量味:每版的可比性签名(评委 prompt hash + debias + 样本集 hash)与「当前内容那版」一致才算 comparable;
 * 换过评委 / 改过样本集的版本标 false —— 渲染据此把跨不可比的段画虚、点画空心,不糊一条误导的「在变好」线
 * (spec evidence-gated-management.md §3「可比性必须可见」)。
 */
import type { ManagedArtifactRecord, ManagedEvidenceRef } from '../types/index.js';

/** buildVersionScores 只需要报告里的这几样 —— 用结构化最小入参而非整个 ReportDocument,叶子可测、与 report schema 解耦。 */
export interface ReportScoreView {
  meta?: { artifactHashes?: Record<string, string> };
  summary?: Record<string, { avgCompositeScore?: number; bootstrapCI?: { low: number; high: number } } | undefined>;
}

export interface VersionScorePoint {
  contentHash: string;
  recordedAt: string;
  composite: number;
  ciLow: number;
  ciHigh: number;
  verdict?: string;
  /** 与基线(当前内容那版)测量条件一致 → 可比;换过评委 / 改过样本集 → false。 */
  comparable: boolean;
}

const ms = (s: string): number | null => { const n = Date.parse(s); return Number.isNaN(n) ? null : n; };
/** 旧→新排序;omk 自写恒 UTC `Z`、字典序即时间序,但记录可手改,两端可解析才用真实时刻、否则退字典序。 */
function olderFirst(a: string, b: string): number {
  const pa = ms(a); const pb = ms(b);
  if (pa !== null && pb !== null) return pa - pb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 一条证据的可比性签名:评委模板 + debias + 样本集,三者全一致才认为两次测量同口径、可直接比分。
 * 缺评委指纹或样本集指纹 → 无从核对是否同口径,返回 null(= unknown);spec §6.1 明确 unknown 既不隐式
 * 放行也不隐式拦截,故调用处把 null 一律按不可比渲染(空心点 + 虚线),不把「不知道能不能比」糊成实线趋势。
 * debias 缺失退空串参与字符串比对(空 debias 是合法状态,非 unknown),只跟同样缺的版本算一致。
 */
function comparabilitySig(ev: ManagedEvidenceRef): string | null {
  const judge = ev.comparability?.judgePromptHash;
  const samples = ev.sampleCoverage?.hash;
  if (!judge || !samples) return null;
  const debias = (ev.comparability?.debiasMode ?? []).slice().sort().join(',');
  return `${judge}|${debias}|${samples}`;
}

export function buildVersionScores(
  record: ManagedArtifactRecord,
  reportsById: Map<string, ReportScoreView | null>,
): VersionScorePoint[] {
  // 一版(contentHash)可能多条证据(重测)→ 按 contentHash 收敛,留 recordedAt 最新且能画出点的那条。
  const byHash = new Map<string, { ev: ManagedEvidenceRef; composite: number; ciLow: number; ciHigh: number }>();
  for (const ev of record.evidence) {
    const report = reportsById.get(ev.reportId);
    if (!report) continue; // 报告已清 / 读不到 → 该点跳过,不臆造
    const hashes = report.meta?.artifactHashes;
    if (!hashes) continue;
    const variant = Object.keys(hashes).find((v) => hashes[v] === ev.contentHash);
    if (!variant) continue; // 匹配不到变体(旧 schema 不绑 / blind 未带哈)→ 跳过
    const s = report.summary?.[variant];
    const composite = s?.avgCompositeScore;
    if (typeof composite !== 'number' || Number.isNaN(composite)) continue; // 无 composite → 无从画点
    const ci = s?.bootstrapCI;
    const ciLow = typeof ci?.low === 'number' ? ci.low : composite;
    const ciHigh = typeof ci?.high === 'number' ? ci.high : composite;
    const prev = byHash.get(ev.contentHash);
    if (!prev || olderFirst(prev.ev.recordedAt, ev.recordedAt) < 0) {
      byHash.set(ev.contentHash, { ev, composite, ciLow, ciHigh });
    }
  }
  const entries = [...byHash.values()].sort((a, b) => olderFirst(a.ev.recordedAt, b.ev.recordedAt));
  if (entries.length === 0) return [];
  // 基线 = 当前内容那版(没有就用最新一条),其余版本与之比对可比性。
  const baselineEntry = byHash.get(record.contentHash) ?? entries[entries.length - 1];
  const baselineSig = comparabilitySig(baselineEntry.ev);
  return entries.map((en) => {
    const sig = comparabilitySig(en.ev);
    // 自身与基线都能核对(签名非 null)且签名一致才算可比;任一缺评委 / 样本指纹(null = unknown)→ 不可比。
    // 基线本身 unknown → baselineSig 为 null → 全版本(含基线自身)不可比,宁可全空心也不把 unknown 糊成可比。
    const comparable = sig !== null && baselineSig !== null && sig === baselineSig;
    return {
      contentHash: en.ev.contentHash,
      recordedAt: en.ev.recordedAt,
      composite: en.composite,
      ciLow: en.ciLow,
      ciHigh: en.ciHigh,
      ...(en.ev.verdict ? { verdict: en.ev.verdict } : {}),
      comparable,
    };
  });
}
