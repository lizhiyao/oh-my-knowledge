import type { CoverageReport } from '../../../observability/analysis/coverage-analyzer.js';
import type { GapSignalRef } from '../../../observability/analysis/contracts.js';
import type { SkillHealth, SkillHealthReport } from '../../../observability/skill-health/analyzer.js';
import { confidenceOf, measuredToolFailureRate, toolStabilityOf } from '../../../observability/skill-health/analyzer.js';
import type { StudioTone } from '../../view-models/display/tone.js';
import type { AnalysisListItem, SkillDiffRow, SkillTrendPoint, SkillTrendResult } from '../../view-models/knowledge/knowledge-reports.js';
import { displayTime, formatPercent, formatPercentDelta } from '../display/format.js';
import { healthBandTone } from '../display/tone.js';

/**
 * Skill 健康度页面组的**事实投影**：色带阈值、样本可信度护栏、工具结果分母、
 * 差值方向、死代码 KB 归属、趋势折线几何。
 *
 * 只服务服务端（由 http/pages/health-page.ts 调用），React 页面只 import 本文件的类型：
 * 值导入会经 analyzer.ts 把 node:fs 拖进客户端 bundle。口径原先散在两份 HTML
 * renderer 里，与 CLI 同名判据一一对应；集中一处，避免页面与 CLI 对同一份报告给出不同结论。
 * 这里不产出标记，也不产出中英文案；数字与时间的文本口径在 `application/display/format.ts`。
 *
 * 比率按 0–1 原样交出，由展示层统一格式化（最多一位小数）；着色阈值仍按「取整后的整数
 * 百分比」判，与 CLI 同名判据一致 —— 换判定口径不是收敛展示口径的顺带后果。
 */

export type HealthConfidence = 'high' | 'low' | 'underpowered';

export type HealthBand = SkillHealthReport['overall']['healthBand'];

type GapSignalType = GapSignalRef['type'];

interface Delta {
  /** 已由 `formatPercentDelta`／整数计数口径算好的展示文本；null 差值不交出片段。 */
  text: string;
  tone: StudioTone;
}

export interface HealthIndexRow extends AnalysisListItem {
  /** 列表圆点的着色口径，与详情页色带同源：样本不足不给硬色。 */
  tone: StudioTone;
}

export interface HealthSkillFacts {
  skillName: string;
  segmentCount: number;
  confidence: HealthConfidence;
  gap: {
    rate: number;
    weightedRate: number;
    /** 硬盲区与加权盲区的差：占比高说明软证据多，结论需人工复核。 */
    softShareRate: number;
    /** 软证据是否多到需要在正文里点出来，判定留在这一侧。 */
    mostlySoft: boolean;
    /** 样本不足时为 neutral，渲染成中性带，不给出硬红。 */
    tone: StudioTone;
    samplesWithGap: number;
    /** 盲区率分母；存储层已保证它与 segmentCount 一致，页面仍读自己那一栏的分母。 */
    sampleCount: number;
    signals: readonly (readonly [GapSignalType, number])[];
  };
  /** null = 该报告没带 KB，覆盖率整栏缺席而不是 0%。 */
  coverage: {
    rate: number;
    tone: StudioTone;
    filesCovered: number;
    filesMissed: number;
    searches: number;
  } | null;
  tools: {
    total: number;
    resolved: number;
    cancelled: number;
    unknown: number;
    /** 失败率分母：取消与状态未知都不进入。 */
    comparable: number;
    failures: number;
    /** null = 无可比较结果，页面不得把它读成 0%。 */
    failureRate: number | null;
    stability: SkillHealth['stability'];
  };
  usage: {
    billableTokens: number;
    cachedTokens: number;
    tokenCoverage: number;
    durationMs: number;
    avgDurationMsPerSegment: number;
    numTurns: number;
  };
}

export interface HealthReportFacts {
  analysisId: string;
  tracePath: string;
  kbPath: string | null;
  timeRange: string;
  /** 原始 ISO 时刻，精度由展示层按 `displayTime` 的口径选择。 */
  generatedAt: string;
  sessionCount: number;
  segmentCount: number;
  toolCallCount: number;
  confidence: HealthConfidence;
  band: HealthBand;
  bandTone: StudioTone;
  /** (1 - 加权盲区) × 100；underpowered 时不给硬分。 */
  score: number | null;
  weightedGapRate: number;
  /** 统计条上的加权盲区着色只看阈值，与色带的低样本守护是两件事。 */
  weightedGapTone: StudioTone;
  ingestion: { malformedRecordCount: number; ignoredValueCount: number; unknownEventCount: number } | null;
  timestamps: {
    segmentCount: number;
    timestampedSegmentCount: number;
    excludedUntimestampedSegmentCount: number;
    incomplete: boolean;
  };
  skills: HealthSkillFacts[];
  deadKb: { total: number; entries: readonly { path: string; type: string; lineCount?: number }[] };
}

interface TrendChart {
  width: number;
  height: number;
  grid: readonly { y: number; label: string }[];
  series: readonly {
    key: 'gap' | 'weighted' | 'failure' | 'coverage';
    line: string;
    dots: readonly { x: number; y: number }[];
  }[];
}

export interface HealthTrendFacts {
  skillName: string;
  points: SkillTrendPoint[];
  chart: TrendChart;
}

interface HealthDiffRow extends SkillDiffRow {
  deltas: { segments: Delta | null; gap: Delta | null; failure: Delta | null; coverage: Delta | null };
}

export interface HealthDiffFacts {
  fromId: string;
  toId: string;
  fromAt: string;
  toAt: string;
  rows: HealthDiffRow[];
}

/** 旧 JSON 缺 confidence 时按 segmentCount 兜底，与 listAnalyses / CLI 同口径。 */
function confidenceOfSkill(skill: Pick<SkillHealth, 'confidence' | 'segmentCount'>): HealthConfidence {
  return skill.confidence ?? confidenceOf(skill.segmentCount);
}

/** 盲区色带阈值（按取整后的整数百分比判，与 CLI 同名判据一致）。 */
function gapTone(pct: number): StudioTone {
  return pct >= 30 ? 'error' : pct >= 10 ? 'warning' : 'success';
}

function coverageTone(pct: number): StudioTone {
  return pct >= 80 ? 'success' : pct >= 50 ? 'warning' : 'error';
}

function bandToneOf(band: HealthBand, confidence: HealthConfidence): StudioTone {
  return confidence === 'underpowered' ? 'neutral' : healthBandTone(band);
}

function healthScoreOf(report: SkillHealthReport): number | null {
  const confidence = report.overall.confidence ?? confidenceOf(report.meta.segmentCount);
  return confidence === 'underpowered' ? null : Math.round((1 - report.overall.weightedGapRate) * 100);
}

export function projectIndexRows(items: readonly AnalysisListItem[]): HealthIndexRow[] {
  return items.map((item) => ({ ...item, tone: bandToneOf(item.healthBand, item.confidence) }));
}

/**
 * 工具结果分母：`toolResolvedCount` 缺席的旧报告按「已记录调用都可判成败」兜底；
 * 取消再从中扣除，未知状态永不进入。稳定性优先取报告值，缺失时按同一阈值重算。
 */
function toolFacts(skill: SkillHealth): HealthSkillFacts['tools'] {
  const resolved = skill.toolResolvedCount ?? Math.max(0, skill.toolCallCount - (skill.toolUnknownCount ?? 0));
  const cancelled = skill.toolCancelledCount ?? 0;
  const comparable = Math.max(0, resolved - cancelled);
  const measured = measuredToolFailureRate(skill);
  return {
    total: skill.toolCallCount,
    resolved,
    cancelled,
    unknown: skill.toolUnknownCount ?? Math.max(0, skill.toolCallCount - resolved),
    comparable,
    failures: skill.toolFailureCount,
    failureRate: measured,
    stability: skill.stability ?? toolStabilityOf(skill.toolFailureRate, comparable, skill.toolCallCount),
  };
}

/** 判定用的整数百分比：阈值沿用 CLI 的「按取整后的百分比判」，展示文本另行格式化。 */
function percentPoints(ratio: number): number {
  return Math.round(ratio * 100);
}

function skillFacts(skill: SkillHealth): HealthSkillFacts {
  const confidence = confidenceOfSkill(skill);
  const gapPoints = percentPoints(skill.gap.gapRate);
  const softSharePoints = gapPoints - percentPoints(skill.gap.weightedGapRate);
  return {
    skillName: skill.skillName,
    segmentCount: skill.segmentCount,
    confidence,
    gap: {
      rate: skill.gap.gapRate,
      weightedRate: skill.gap.weightedGapRate,
      softShareRate: skill.gap.gapRate - skill.gap.weightedGapRate,
      mostlySoft: softSharePoints >= 10,
      tone: confidence === 'underpowered' ? 'neutral' : gapTone(gapPoints),
      samplesWithGap: skill.gap.samplesWithGap,
      sampleCount: skill.gap.sampleCount,
      signals: (Object.entries(skill.gap.byType) as (readonly [GapSignalType, number])[]).filter(([, count]) => count > 0),
    },
    coverage: skill.coverage === null ? null : coverageFacts(skill.coverage),
    tools: toolFacts(skill),
    usage: {
      billableTokens: (skill.usage?.inputTokens ?? 0) + (skill.usage?.outputTokens ?? 0),
      cachedTokens: (skill.usage?.cacheReadTokens ?? 0) + (skill.usage?.cacheCreationTokens ?? 0),
      tokenCoverage: skill.usage?.tokenCoverage ?? 0,
      durationMs: skill.usage?.durationMs ?? 0,
      avgDurationMsPerSegment: skill.usage?.avgDurationMsPerSegment ?? 0,
      numTurns: skill.usage?.numTurns ?? 0,
    },
  };
}

function coverageFacts(coverage: CoverageReport): NonNullable<HealthSkillFacts['coverage']> {
  return {
    rate: coverage.fileCoverageRate,
    tone: coverageTone(percentPoints(coverage.fileCoverageRate)),
    filesCovered: coverage.filesCovered,
    filesMissed: coverage.filesTotal - coverage.filesCovered,
    searches: coverage.grepPatternsUsed,
  };
}

/** 时间窗标签按 UTC 日期归一；无法解析的时间戳原样交出，不让页面因脏数据抛错。 */
function timeRangeOf(range: SkillHealthReport['meta']['timeRange']): string {
  if (!range.from || !range.to) return '—';
  const day = (value: string): string => {
    const parsed = new Date(value);
    return displayTime(Number.isNaN(parsed.getTime()) ? value : parsed.toISOString(), 'day');
  };
  const from = day(range.from);
  const to = day(range.to);
  return from === to ? from : `${from} → ${to}`;
}

export function projectReport(analysisId: string, report: SkillHealthReport): HealthReportFacts {
  const confidence = confidenceOfSkill({ confidence: report.overall.confidence, segmentCount: report.meta.segmentCount });
  const ingestion = report.meta.ingestion;
  const needsIngestionNotice = ingestion !== undefined
    && (ingestion.malformedRecordCount > 0 || ingestion.ignoredValueCount > 0 || ingestion.unknownEventCount > 0);
  const timestamped = report.meta.timestampedSegmentCount
    ?? (report.meta.timeRange.from && report.meta.timeRange.to ? report.meta.segmentCount : 0);
  const timestampCoverage = report.meta.timestampCoverage ?? (report.meta.segmentCount > 0 ? timestamped / report.meta.segmentCount : 1);
  const excluded = report.meta.excludedUntimestampedSegmentCount ?? 0;
  return {
    analysisId,
    tracePath: report.meta.tracePath,
    kbPath: report.meta.kbPath,
    timeRange: timeRangeOf(report.meta.timeRange),
    generatedAt: report.meta.generatedAt,
    sessionCount: report.meta.sessionCount,
    segmentCount: report.meta.segmentCount,
    toolCallCount: report.meta.toolCallCount,
    confidence,
    band: report.overall.healthBand,
    bandTone: bandToneOf(report.overall.healthBand, confidence),
    score: healthScoreOf(report),
    weightedGapRate: report.overall.weightedGapRate,
    weightedGapTone: gapTone(percentPoints(report.overall.weightedGapRate)),
    ingestion: needsIngestionNotice && ingestion
      ? { malformedRecordCount: ingestion.malformedRecordCount, ignoredValueCount: ingestion.ignoredValueCount, unknownEventCount: ingestion.unknownEventCount }
      : null,
    timestamps: {
      segmentCount: report.meta.segmentCount,
      timestampedSegmentCount: timestamped,
      excludedUntimestampedSegmentCount: excluded,
      incomplete: timestampCoverage < 1 || excluded > 0,
    },
    skills: Object.values(report.bySkill)
      .sort((a, b) => b.segmentCount - a.segmentCount)
      .map(skillFacts),
    deadKb: deadKbOf(report),
  };
}

/**
 * 死代码 KB：所有 skill 访问集合并集之外的 KB 文件。取首个 coverage 清单作为文件全集
 * （同一份报告的各 skill 共享同一 KB 索引）。无 KB 或无 coverage 时整体不出现。
 */
function deadKbOf(report: SkillHealthReport): HealthReportFacts['deadKb'] {
  const coverages = Object.values(report.bySkill)
    .map((skill) => skill.coverage)
    .filter((coverage): coverage is CoverageReport => coverage !== null);
  const allEntries = coverages[0]?.entries ?? [];
  if (allEntries.length === 0) return { total: 0, entries: [] };
  const accessed = new Set<string>();
  for (const coverage of coverages) {
    for (const entry of coverage.entries) if (entry.accessed) accessed.add(entry.path);
  }
  return {
    total: allEntries.length,
    entries: allEntries
      .filter((entry) => !accessed.has(entry.path))
      .map((entry) => ({ path: entry.path, type: entry.type, ...(entry.lineCount === undefined ? {} : { lineCount: entry.lineCount }) })),
  };
}

/** 差值着色：不足 1 个百分点是噪声，不给颜色。 */
function deltaTone(points: number, direction: 'lower' | 'higher'): StudioTone {
  if (Math.abs(points) < 1) return 'neutral';
  const improves = direction === 'higher' ? points > 0 : points < 0;
  return improves ? 'success' : 'error';
}

/** 比率差值：文本走 `formatPercentDelta`，与页面其余百分数同一套舍入与字形。 */
function percentDelta(delta: number | null | undefined, direction: 'lower' | 'higher'): Delta | null {
  if (delta == null) return null;
  return { text: formatPercentDelta(delta), tone: deltaTone(delta * 100, direction) };
}

/** 计数差值（段数）：只表达变化量，不表达好坏，因此一律不着色。 */
function countDelta(delta: number | null | undefined): Delta | null {
  if (delta == null) return null;
  return { text: `${delta > 0 ? '+' : ''}${Math.round(delta)}`, tone: 'neutral' };
}

export function projectDiff(rows: readonly SkillDiffRow[]): HealthDiffRow[] {
  return rows.map((row) => ({
    ...row,
    deltas: {
      segments: countDelta(row.deltaSegments),
      gap: percentDelta(row.deltaGap, 'lower'),
      failure: percentDelta(row.deltaFailure, 'lower'),
      coverage: percentDelta(row.deltaCoverage, 'higher'),
    },
  }));
}

const CHART = { width: 760, height: 200, pad: 40 } as const;

/**
 * 趋势折线几何：单点居中，取值缺席处断开折线（跨缺口不连线）。
 * 不做取值钳制——越界的比率会画出坐标轴外，那是数据问题，不该由图形掩盖。
 */
export function projectTrend(trend: SkillTrendResult): HealthTrendFacts {
  const { points } = trend;
  const xPos = (index: number): number => (points.length === 1
    ? CHART.width / 2
    : CHART.pad + (index / (points.length - 1)) * (CHART.width - 2 * CHART.pad));
  const seriesOf = (select: (point: SkillTrendPoint) => number | null) => {
    const dots: { x: number; y: number }[] = [];
    let line = '';
    let drawing = false;
    points.forEach((point, index) => {
      const value = select(point);
      if (value == null) {
        drawing = false;
        return;
      }
      const x = xPos(index);
      const y = CHART.height - CHART.pad - value * (CHART.height - 2 * CHART.pad);
      line += `${line === '' ? '' : ' '}${drawing ? 'L' : 'M'} ${x} ${y}`;
      drawing = true;
      dots.push({ x, y });
    });
    return { line, dots };
  };
  return {
    skillName: trend.skillName,
    points,
    chart: {
      width: CHART.width,
      height: CHART.height,
      grid: [0, 0.5, 1].map((value) => ({
        y: CHART.height - CHART.pad - value * (CHART.height - 2 * CHART.pad),
        label: formatPercent(value),
      })),
      series: [
        { key: 'gap' as const, ...seriesOf((point) => point.gapRate) },
        { key: 'weighted' as const, ...seriesOf((point) => point.weightedGapRate) },
        { key: 'failure' as const, ...seriesOf((point) => point.failureRate) },
        { key: 'coverage' as const, ...seriesOf((point) => point.coverageRate) },
      ],
    },
  };
}
