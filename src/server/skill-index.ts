/**
 * Skill-centric 聚合 — 顶级实体从"报告"翻成"skill",每个 skill 在 4 类报告
 * (doctor / eval-评分 / eval-功能 / observe)上各取最新一份做 status 摘要,
 * 给 studio 列表页用。
 *
 * 当前 v1 范围:
 *   - eval 报告(reportsDir):按 treatment variant 名分桶,跳过 baseline 保留字。
 *     评分视角(verdict / 综合分)和功能视角(pass/fail/tripwire 计数)挤一份 snapshot,
 *     因为同一份 EvaluationReport 同时驱动两个 view tab。
 *   - observe 报告(analysesDir, SkillHealthReport):data.bySkill[name] 每个键作为
 *     一个 skill 的 observe snapshot,取最新 generatedAt。
 *   - doctor:暂无独立持久化路径(omk doctor --html 写指定路径,默认不存盘),
 *     该字段保留 null,渲染层显示"未独立运行 omk doctor"。后续 commit 加默认
 *     ~/.oh-my-knowledge/doctors/ 持久化路径再回填。
 *
 * 综合 band:eval / observe 任一红 → 红,任一黄 → 黄,全绿 → 绿,皆未跑 → gray。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReportDocument, EvaluationReport, AssertionDetail } from '../types/index.js';
import type { SkillHealthReport } from '../observability/skill-health-analyzer.js';
import { computeVerdict } from '../eval-core/verdict.js';

export interface SkillEvalSnapshot {
  reportId: string;
  timestamp: string;
  variantName: string;
  verdictLevel: string;
  verdictHeadline: string;
  compositeScore: number | null;
  passCount: number;
  failCount: number;
  tripwireCount: number;
  totalSamples: number;
}

export interface SkillObserveSnapshot {
  analysisId: string;
  generatedAt: string;
  healthBand: 'green' | 'yellow' | 'red';
  failureRate: number;
  segmentCount: number;
  gapRate: number;
}

export interface SkillIndexEntry {
  skillName: string;
  /** v1 占位;后续 doctor 持久化后回填。 */
  doctor: null;
  eval: SkillEvalSnapshot | null;
  observe: SkillObserveSnapshot | null;
  /** 综合健康灯。eval / observe 任一红 → red;任一黄 → yellow;
   *  全绿 → green;皆未跑 → gray。 */
  band: 'green' | 'yellow' | 'red' | 'gray';
}

export interface SkillIndexSummary {
  totalSkills: number;
  withEval: number;
  withObserve: number;
  withDoctor: number;
  red: number;
  yellow: number;
  green: number;
  gray: number;
}

export interface SkillIndex {
  entries: SkillIndexEntry[];
  summary: SkillIndexSummary;
}

function sampleAllPassed(details: AssertionDetail[] | undefined): boolean {
  if (!details || details.length === 0) return true;
  return details.every((d) => d.passed);
}

function buildEvalSnapshot(report: EvaluationReport, variant: string): SkillEvalSnapshot | null {
  const summary = report.summary?.[variant];
  if (!summary) return null;
  let pass = 0;
  let fail = 0;
  let tripwire = 0;
  for (const r of report.results) {
    const vr = r.variants?.[variant];
    if (!vr) continue;
    const allPassed = sampleAllPassed(vr.assertions?.details);
    const isTripwire = report.sampleSnapshots?.[r.sample_id]?.tripwire === true
      || (vr.diagnostic?.rootCause || []).includes('tripwire_intentional');
    if (allPassed) pass += 1;
    else if (isTripwire) tripwire += 1;
    else fail += 1;
  }

  // verdict 是运行期计算的,不进 report,这里现算。
  let verdictLevel = 'unknown';
  let verdictHeadline = '';
  try {
    const v = computeVerdict(report);
    verdictLevel = v.level;
    verdictHeadline = v.headline;
  } catch { /* 单 variant 报告 / control 缺失等情况 — 留 unknown 默认 */ }

  return {
    reportId: report.id,
    timestamp: report.meta.timestamp || '',
    variantName: variant,
    verdictLevel,
    verdictHeadline,
    compositeScore: summary.avgCompositeScore ?? null,
    passCount: pass,
    failCount: fail,
    tripwireCount: tripwire,
    totalSamples: pass + fail + tripwire,
  };
}

function bandFromObserveHealth(h: { gap?: { weightedGapRate?: number }; toolFailureRate: number }): 'green' | 'yellow' | 'red' {
  // 跟 observability/skill-health-analyzer.ts 的阈值口径对齐。
  if (h.toolFailureRate >= 0.4) return 'red';
  const gap = h.gap?.weightedGapRate ?? 0;
  if (gap >= 0.3 || h.toolFailureRate >= 0.2) return 'yellow';
  return 'green';
}

function combineBand(
  evalSnap: SkillEvalSnapshot | null,
  observe: SkillObserveSnapshot | null,
): 'green' | 'yellow' | 'red' | 'gray' {
  if (!evalSnap && !observe) return 'gray';
  // eval band:按真实 fail 占比(诱错不算,total 不含)估色。
  const evalDenom = evalSnap ? evalSnap.passCount + evalSnap.failCount : 0;
  const failRatio = evalDenom > 0 ? (evalSnap!.failCount / evalDenom) : 0;
  const evalBand: 'green' | 'yellow' | 'red' | 'gray' = !evalSnap
    ? 'gray'
    : failRatio >= 0.5 ? 'red'
    : failRatio >= 0.2 ? 'yellow'
    : 'green';
  const obsBand: 'green' | 'yellow' | 'red' | 'gray' = observe?.healthBand ?? 'gray';
  if (evalBand === 'red' || obsBand === 'red') return 'red';
  if (evalBand === 'yellow' || obsBand === 'yellow') return 'yellow';
  if (evalBand === 'green' || obsBand === 'green') return 'green';
  return 'gray';
}

function latestActivityTs(e: SkillIndexEntry): string {
  const candidates = [e.eval?.timestamp, e.observe?.generatedAt].filter((s): s is string => Boolean(s));
  return candidates.sort().pop() || '';
}

/**
 * 扫 reports + analyses 目录,按 skill 名聚合。reports 通过 reportStore.list() 传入
 * (避免重复读盘 + 避免再写一份 list 逻辑);analysesDir 直接扫。
 *
 * 同 skill 多份报告时取 timestamp 最新的一份。
 */
export function buildSkillIndex(
  reports: ReportDocument[],
  analysesDir: string,
): SkillIndex {
  // ── eval 聚合 ──────────────────────────────────────────────
  const evalBy: Record<string, SkillEvalSnapshot> = {};
  for (const r of reports) {
    if (r.kind !== 'evaluation') continue;
    const variants = r.meta.variants || [];
    for (const v of variants) {
      // baseline 是保留 variant 名,代表"不注入 skill 的裸基线",不当 skill 看。
      if (v === 'baseline') continue;
      const snap = buildEvalSnapshot(r, v);
      if (!snap) continue;
      const prev = evalBy[v];
      if (!prev || snap.timestamp > prev.timestamp) evalBy[v] = snap;
    }
  }

  // ── observe 聚合 ──────────────────────────────────────────
  const observeBy: Record<string, SkillObserveSnapshot> = {};
  if (existsSync(analysesDir)) {
    for (const file of readdirSync(analysesDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(analysesDir, file), 'utf-8')) as SkillHealthReport;
        if (!data?.bySkill || !data.meta) continue;
        const generatedAt = data.meta.generatedAt;
        const id = file.replace(/\.json$/, '');
        for (const [skill, h] of Object.entries(data.bySkill)) {
          const snap: SkillObserveSnapshot = {
            analysisId: id,
            generatedAt,
            healthBand: bandFromObserveHealth(h),
            failureRate: h.toolFailureRate,
            segmentCount: h.segmentCount,
            gapRate: h.gap?.weightedGapRate ?? 0,
          };
          const prev = observeBy[skill];
          if (!prev || snap.generatedAt > prev.generatedAt) observeBy[skill] = snap;
        }
      } catch { /* skip corrupt */ }
    }
  }

  // ── 合并 ──────────────────────────────────────────────────
  const allSkills = new Set<string>([...Object.keys(evalBy), ...Object.keys(observeBy)]);
  const entries: SkillIndexEntry[] = [];
  for (const name of allSkills) {
    const evalSnap = evalBy[name] ?? null;
    const observe = observeBy[name] ?? null;
    entries.push({
      skillName: name,
      doctor: null,
      eval: evalSnap,
      observe,
      band: combineBand(evalSnap, observe),
    });
  }
  entries.sort((a, b) => latestActivityTs(b).localeCompare(latestActivityTs(a)));

  // ── summary ───────────────────────────────────────────────
  const summary: SkillIndexSummary = {
    totalSkills: entries.length,
    withEval: entries.filter((e) => e.eval).length,
    withObserve: entries.filter((e) => e.observe).length,
    withDoctor: 0, // v1 占位
    red: entries.filter((e) => e.band === 'red').length,
    yellow: entries.filter((e) => e.band === 'yellow').length,
    green: entries.filter((e) => e.band === 'green').length,
    gray: entries.filter((e) => e.band === 'gray').length,
  };

  return { entries, summary };
}
