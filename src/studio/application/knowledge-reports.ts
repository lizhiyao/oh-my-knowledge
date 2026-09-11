import { existsSync, readFileSync } from 'node:fs';
import type { DoctorReport } from '../../knowledge-artifacts/doctor/contracts.js';
import { parseDoctorReport } from '../../knowledge-artifacts/doctor/report-parser.js';
import { listDoctorCards, listLiveObserveCards, listObserveCards } from '../../evidence/storage/discovery-index.js';
import { listMeasurementReportPaths, measurementRecordIdFromReportPath } from '../../evidence/storage/report-bundle.js';
import { confidenceOf, measuredToolFailureRate, toolStabilityOf, type SkillHealth, type SkillHealthReport } from '../../observability/skill-health/analyzer.js';
import { parseSkillHealthReport } from '../../observability/skill-health/report.js';
import { ownRecordValue } from '../../shared/record-count.js';
import type { AnalysisListItem, SkillTrendPoint, SkillTrendResult, SkillDiffRow, SkillDiffResult } from '../view-models/knowledge-reports.js';

export function listAnalyses(dir: string, includeCards = false): AnalysisListItem[] {
  const items: AnalysisListItem[] = [];
  const seenLiveIds = new Set<string>();
  // live 扫描 dir 存在才做;dir 不存在(默认机器级模式下当前项目还没 .omk/observe/health、全局也空)时 live 为空,
  // 但**不能早退** —— 后面仍要按 includeCards 合并别项目卡片,否则 observe 列表会与合卡片的 /api/skills 口径分裂。
  for (const path of listMeasurementReportPaths(dir, 'observe-health')) {
    const id = measurementRecordIdFromReportPath(path);
    if (!id || seenLiveIds.has(id)) continue;
    try {
      const data = parseSkillHealthReport(JSON.parse(readFileSync(path, 'utf-8')));
      if (!data) continue;
      items.push({
        id,
        generatedAt: data.meta.generatedAt,
        sessionCount: data.meta.sessionCount,
        segmentCount: data.meta.segmentCount,
        skillCount: Object.keys(data.bySkill || {}).length,
        healthBand: data.overall.healthBand,
        // 旧 JSON 缺 confidence 时按 segmentCount 兜底,跟 Studio / CLI 口径一致。
        confidence: data.overall.confidence ?? confidenceOf(data.meta.segmentCount),
      });
      seenLiveIds.add(id);
    } catch { /* skip corrupt */ }
  }
  // 别项目的 observe 卡片(当前 dir live 扫不到的项目)→ list item,dedup by id(live 盖卡片)。
  // 仅机器级模式合并;固定 --analyses-dir / --global 时 includeCards=false,只看该目录(逃生舱语义)。
  if (includeCards) {
    const seen = new Set(items.map((i) => i.id));
    for (const card of listLiveObserveCards()) {
      if (seen.has(card.id)) continue;
      let report: SkillHealthReport | null = null;
      try {
        report = parseSkillHealthReport(JSON.parse(readFileSync(card.path, 'utf-8')));
      } catch {
        // Scratch cards only discover the canonical report; corrupt targets stay invisible.
      }
      if (!report) continue;
      items.push({
        id: card.id,
        generatedAt: report.meta.generatedAt,
        sessionCount: report.meta.sessionCount,
        segmentCount: report.meta.segmentCount,
        skillCount: Object.keys(report.bySkill).length,
        healthBand: report.overall.healthBand,
        confidence: report.overall.confidence ?? confidenceOf(report.meta.segmentCount),
      });
      seen.add(card.id);
    }
  }
  // 最新在前
  items.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  return items;
}

export function loadAnalysis(dir: string, id: string, includeCards = false): SkillHealthReport | null {
  const path = listMeasurementReportPaths(dir, 'observe-health')
    .find((candidate) => measurementRecordIdFromReportPath(candidate) === id);
  if (path !== undefined) {
    try {
      const report = parseSkillHealthReport(JSON.parse(readFileSync(path, 'utf-8')));
      if (report) return report;
    } catch { /* fall through to card */ }
  }
  // 别项目:按 observe 卡片 path 读真身(含 signals 等完整详情)。悬空(项目被移走)→ null,详情页 404。
  // 仅机器级模式兜底;固定目录 / --global 不回源别项目卡片(逃生舱语义)。
  if (!includeCards) return null;
  const card = listObserveCards().find((c) => c.id === id);
  if (card && existsSync(card.path)) {
    try {
      return parseSkillHealthReport(JSON.parse(readFileSync(card.path, 'utf-8')));
    } catch { /* corrupt 真身 */ }
  }
  return null;
}

/** 扫 doctorsDir 找 id 匹配的 doctor 报告（文件名不一定等于 report id）。
 *  批量 doctor 会按 skill 拆成多份共享同一 id 的 per-skill 文件，传 skillName 时
 *  优先返回含该 skill 的那份；都不含时回退首个 id 命中（单 skill / 无参行为不变）。 */
export function loadDoctorReport(dir: string, id: string, skillName?: string, includeCards = false): DoctorReport | null {
  let fallback: DoctorReport | null = null;
  const seenRecords = new Set<string>();
  for (const path of listMeasurementReportPaths(dir, 'doctor')) {
    const recordId = measurementRecordIdFromReportPath(path);
    if (recordId === null || seenRecords.has(recordId)) continue;
    try {
      const data = parseDoctorReport(JSON.parse(readFileSync(path, 'utf-8')));
      if (!data || data.id !== id) continue;
      seenRecords.add(recordId);
      if (!skillName || data.skills?.some((s) => s.skillName === skillName)) return data;
      fallback ??= data;
    } catch { /* skip */ }
  }
  if (fallback) return fallback;
  // 仅机器级模式兜底;固定 --doctors-dir / --global 不回源别项目卡片(逃生舱语义)。
  if (!includeCards) return null;
  // 别项目:按 doctor 卡片(reportId 匹配 + 可选 skillName)的 path 读真身。detail 路由传的 id 是 reportId(非卡片 stem)。
  for (const card of listDoctorCards()) {
    if (card.reportId !== id) continue;
    if (skillName && card.skillName !== skillName) continue;
    if (!existsSync(card.path)) continue;
    try {
      const data = parseDoctorReport(JSON.parse(readFileSync(card.path, 'utf-8')));
      if (data && data.id === id) {
        if (!skillName || data.skills?.some((s) => s.skillName === skillName)) return data;
        fallback ??= data;
      }
    } catch { /* corrupt 真身 */ }
  }
  return fallback;
}

function trendPointOf(analysisId: string, generatedAt: string, h: SkillHealth): SkillTrendPoint {
  // 旧格式 (加 usage 字段前的 analysis) 用 safe access,缺字段降级为 0/undefined
  const u = h.usage;
  const billable = (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0);
  const cached = (u?.cacheReadTokens ?? 0) + (u?.cacheCreationTokens ?? 0);
  const toolCallCount = h.toolCallCount ?? 0;
  const toolResolvedCount = h.toolResolvedCount ?? toolCallCount;
  const toolCancelledCount = h.toolCancelledCount ?? 0;
  const toolComparableCount = Math.max(0, toolResolvedCount - toolCancelledCount);
  return {
    analysisId,
    generatedAt,
    gapRate: h.gap?.gapRate ?? 0,
    weightedGapRate: h.gap?.weightedGapRate ?? 0,
    failureRate: measuredToolFailureRate(h),
    toolCallCount,
    toolResolvedCount,
    toolComparableCount,
    toolCancelledCount,
    toolOutcomeCoverage: toolCallCount > 0
      ? Number((toolResolvedCount / toolCallCount).toFixed(4))
      : null,
    coverageRate: h.coverage?.fileCoverageRate ?? null,
    billableTokens: billable,
    cachedTokens: cached,
    totalTokens: u?.totalTokens ?? 0,
    avgTokensPerSegment: u?.avgTokensPerSegment ?? 0,
    tokenCoverage: u?.tokenCoverage ?? 0,
    durationMs: u?.durationMs ?? 0,
    segmentCount: h.segmentCount ?? 0,
    stability: observedToolStability(h),
  };
}

/**
 * 单遍扫描 analyses/ 提取指定 skill 的 trend points,按时间排序（最旧在前）。
 * 历史实现先 listAnalyses 全量解析、再逐条 loadAnalysis 重新扫目录，
 * 成本为 O(N²) 目录扫描 + 2N 次解析（issue #836 1.2 基线 large 档实测 2.3s）；
 * 现在 1 次目录扫描 + N 次解析。口径与 listAnalyses 一致：live 优先、
 * 卡片仅机器级模式合并且按 id 去重。
 */
export function querySkillTrend(dir: string, skillName: string, includeCards = false): SkillTrendResult {
  const points: SkillTrendPoint[] = [];
  const seenLiveIds = new Set<string>();
  const collect = (id: string, report: SkillHealthReport) => {
    const health = ownRecordValue(report.bySkill, skillName);
    if (health) points.push(trendPointOf(id, report.meta.generatedAt, health));
  };
  for (const path of listMeasurementReportPaths(dir, 'observe-health')) {
    const id = measurementRecordIdFromReportPath(path);
    if (!id || seenLiveIds.has(id)) continue;
    try {
      const report = parseSkillHealthReport(JSON.parse(readFileSync(path, 'utf-8')));
      if (!report) continue;
      seenLiveIds.add(id);
      collect(id, report);
    } catch { /* skip corrupt */ }
  }
  // 仅机器级模式合并别项目卡片;固定目录 / --global 只看该目录(逃生舱语义)。
  if (includeCards) {
    for (const card of listLiveObserveCards()) {
      if (seenLiveIds.has(card.id)) continue;
      let report: SkillHealthReport | null = null;
      try {
        report = parseSkillHealthReport(JSON.parse(readFileSync(card.path, 'utf-8')));
      } catch { /* corrupt 真身保持不可见 */ }
      if (!report) continue;
      seenLiveIds.add(card.id);
      collect(card.id, report);
    }
  }
  points.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  return { skillName, points };
}

function observedToolStability(
  health: Pick<
    SkillHealth,
    'stability' | 'toolCallCount' | 'toolResolvedCount' | 'toolCancelledCount' | 'toolFailureRate'
  >,
): SkillTrendPoint['stability'] {
  if (health.stability === 'unknown') return 'unknown';
  const failureRate = measuredToolFailureRate(health);
  if (failureRate == null) return 'unknown';
  const resolvedToolCalls = health.toolResolvedCount ?? health.toolCallCount;
  const comparableToolCalls = Math.max(
    0,
    resolvedToolCalls - (health.toolCancelledCount ?? 0),
  );
  return toolStabilityOf(failureRate, comparableToolCalls, health.toolCallCount);
}

/**
 * 比较两份 skill health report. `from` 通常是较早的,`to` 是较晚的;
 * 对于每个 skill, 显示前后值和 delta. 缺失一侧时 presence 标记。
 */
export function querySkillDiff(dir: string, fromId: string, toId: string, includeCards = false): SkillDiffResult | null {
  const from = loadAnalysis(dir, fromId, includeCards);
  const to = loadAnalysis(dir, toId, includeCards);
  if (!from || !to) return null;
  const allSkills = new Set<string>([...Object.keys(from.bySkill), ...Object.keys(to.bySkill)]);
  const rows: SkillDiffRow[] = [];
  for (const skill of allSkills) {
    const f = ownRecordValue(from.bySkill, skill);
    const t = ownRecordValue(to.bySkill, skill);
    if (f && t) {
      const fromFailure = measuredToolFailureRate(f);
      const toFailure = measuredToolFailureRate(t);
      rows.push({
        skillName: skill,
        presence: 'both',
        fromGap: f.gap.weightedGapRate,
        toGap: t.gap.weightedGapRate,
        deltaGap: t.gap.weightedGapRate - f.gap.weightedGapRate,
        fromFailure,
        toFailure,
        deltaFailure: fromFailure != null && toFailure != null
          ? toFailure - fromFailure
          : undefined,
        fromCoverage: f.coverage?.fileCoverageRate ?? null,
        toCoverage: t.coverage?.fileCoverageRate ?? null,
        deltaCoverage: (f.coverage?.fileCoverageRate != null && t.coverage?.fileCoverageRate != null)
          ? t.coverage.fileCoverageRate - f.coverage.fileCoverageRate
          : null,
        fromSegments: f.segmentCount,
        toSegments: t.segmentCount,
        deltaSegments: t.segmentCount - f.segmentCount,
      });
    } else if (f) {
      rows.push({ skillName: skill, presence: 'only-from', fromGap: f.gap.weightedGapRate, fromFailure: measuredToolFailureRate(f), fromCoverage: f.coverage?.fileCoverageRate ?? null, fromSegments: f.segmentCount });
    } else if (t) {
      rows.push({ skillName: skill, presence: 'only-to', toGap: t.gap.weightedGapRate, toFailure: measuredToolFailureRate(t), toCoverage: t.coverage?.fileCoverageRate ?? null, toSegments: t.segmentCount });
    }
  }
  // 按 deltaGap 绝对值倒序 (变化大的在前,缺失的放最后)
  rows.sort((a, b) => {
    const aDelta = a.presence === 'both' ? Math.abs(a.deltaGap!) : -1;
    const bDelta = b.presence === 'both' ? Math.abs(b.deltaGap!) : -1;
    return bDelta - aDelta;
  });
  return { fromId, toId, fromAt: from.meta.generatedAt, toAt: to.meta.generatedAt, rows };
}

