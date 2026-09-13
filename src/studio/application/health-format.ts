import type { CoverageReport } from '../../observability/analysis/coverage-analyzer.js';
import type { GapSignalRef } from '../../observability/analysis/contracts.js';
import type { SkillHealth, SkillHealthReport } from '../../observability/skill-health/analyzer.js';
import { confidenceOf, measuredToolFailureRate, toolStabilityOf } from '../../observability/skill-health/analyzer.js';
import type { AnalysisListItem, SkillDiffRow, SkillTrendPoint, SkillTrendResult } from '../view-models/knowledge-reports.js';

/**
 * Skill 健康度页面组的**事实投影**：色带阈值、样本可信度护栏、工具结果分母、
 * 差值方向、死代码 KB 归属、趋势折线几何。
 *
 * 只服务服务端（由 http/health-page.ts 调用），React 页面只 import 本文件的类型：
 * 值导入会经 analyzer.ts 把 node:fs 拖进客户端 bundle。口径原先散在两份 HTML
 * renderer 里，与 CLI 同名判据一一对应；集中一处，避免页面与 CLI 对同一份报告给出不同结论。
 * 这里不产出标记，也不产出中英文案（除 `—`、`42%` 这类语言无关的数字文本）。
 */

/** 语义着色档位；`neutral` 表示该取值本身不表达好坏，或样本不足以支撑结论。 */
export type HealthTone = 'success' | 'warning' | 'error' | 'neutral';

export type HealthConfidence = 'high' | 'low' | 'underpowered';

export type HealthBand = SkillHealthReport['overall']['healthBand'];

export type GapSignalType = GapSignalRef['type'];

export interface Delta {
  /** 形如 `+1.2%` / `-3`；null 差值不交出片段。 */
  text: string;
  tone: HealthTone;
}

export interface HealthIndexRow extends AnalysisListItem {
  /** 列表圆点的着色口径，与详情页色带同源：样本不足不给硬色。 */
  tone: HealthTone;
}

export interface HealthSkillFacts {
  skillName: string;
  segmentCount: number;
  confidence: HealthConfidence;
  gap: {
    percent: number;
    weightedPercent: number;
    /** 硬盲区与加权盲区的差值：占比高说明软证据多，结论需人工复核。 */
    softSharePercent: number;
    /** 样本不足时为 neutral，渲染成中性带，不给出硬红。 */
    tone: HealthTone;
    samplesWithGap: number;
    /** 盲区率分母；存储层已保证它与 segmentCount 一致，页面仍读自己那一栏的分母。 */
    sampleCount: number;
    signals: readonly (readonly [GapSignalType, number])[];
  };
  /** null = 该报告没带 KB，覆盖率整栏缺席而不是 0%。 */
  coverage: {
    percent: number;
    tone: HealthTone;
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
    /** 无可比较结果时为 null，页面不得把它读成 0%。 */
    failureRatePercent: number | null;
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
  generatedAt: string;
  sessionCount: number;
  segmentCount: number;
  toolCallCount: number;
  confidence: HealthConfidence;
  band: HealthBand;
  bandTone: HealthTone;
  /** (1 - 加权盲区) × 100；underpowered 时不给硬分。 */
  score: number | null;
  gapPercent: number;
  weightedGapPercent: number;
  /** 统计条上的加权盲区着色只看阈值，与色带的低样本守护是两件事。 */
  weightedGapTone: HealthTone;
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

export interface TrendChart {
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

export interface HealthDiffRow extends SkillDiffRow {
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

/** 盲区色带阈值（按取整后的百分比判，与既有渲染一致）。 */
function gapTone(pct: number): HealthTone {
  return pct >= 30 ? 'error' : pct >= 10 ? 'warning' : 'success';
}

function coverageTone(pct: number): HealthTone {
  return pct >= 80 ? 'success' : pct >= 50 ? 'warning' : 'error';
}

function bandToneOf(band: HealthBand, confidence: HealthConfidence): HealthTone {
  return confidence === 'underpowered' ? 'neutral' : band === 'red' ? 'error' : band === 'yellow' ? 'warning' : 'success';
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
    failureRatePercent: measured === null ? null : Math.round(measured * 100),
    stability: skill.stability ?? toolStabilityOf(skill.toolFailureRate, comparable, skill.toolCallCount),
  };
}

function skillFacts(skill: SkillHealth): HealthSkillFacts {
  const confidence = confidenceOfSkill(skill);
  const gapPercent = Math.round(skill.gap.gapRate * 100);
  const weightedPercent = Math.round(skill.gap.weightedGapRate * 100);
  return {
    skillName: skill.skillName,
    segmentCount: skill.segmentCount,
    confidence,
    gap: {
      percent: gapPercent,
      weightedPercent,
      softSharePercent: gapPercent - weightedPercent,
      tone: confidence === 'underpowered' ? 'neutral' : gapTone(gapPercent),
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
  const percent = Math.round(coverage.fileCoverageRate * 100);
  return {
    percent,
    tone: coverageTone(percent),
    filesCovered: coverage.filesCovered,
    filesMissed: coverage.filesTotal - coverage.filesCovered,
    searches: coverage.grepPatternsUsed,
  };
}

/** 时间窗标签按 UTC 日期归一；无法解析的时间戳保留原始日期前缀，不让页面因脏数据抛错。 */
function timeRangeOf(range: SkillHealthReport['meta']['timeRange']): string {
  if (!range.from || !range.to) return '—';
  const day = (value: string): string => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value.slice(0, 10) : parsed.toISOString().slice(0, 10);
  };
  const from = day(range.from);
  const to = day(range.to);
  return from === to ? from : `${from} → ${to}`;
}

/** 报告生成时间：截到分钟，秒对结论无信息量。 */
function stampOf(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
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
    generatedAt: stampOf(report.meta.generatedAt),
    sessionCount: report.meta.sessionCount,
    segmentCount: report.meta.segmentCount,
    toolCallCount: report.meta.toolCallCount,
    confidence,
    band: report.overall.healthBand,
    bandTone: bandToneOf(report.overall.healthBand, confidence),
    score: healthScoreOf(report),
    gapPercent: Math.round(report.overall.gapRate * 100),
    weightedGapPercent: Math.round(report.overall.weightedGapRate * 100),
    weightedGapTone: gapTone(Math.round(report.overall.weightedGapRate * 100)),
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

/** 差值文本与着色：`direction` 说明该指标越低越好、越高越好还是只表达变化量。 */
function deltaOf(delta: number | null | undefined, direction: 'lower' | 'higher' | 'neutral', isPercent = true): Delta | null {
  if (delta == null) return null;
  const value = isPercent ? delta * 100 : delta;
  const improves = direction === 'higher' ? value > 0 : value < 0;
  return {
    text: `${value > 0 ? '+' : ''}${value.toFixed(isPercent ? 1 : 0)}${isPercent ? '%' : ''}`,
    // 幅度不足 1（1pp／1 段）不着色，避免把噪声读成结论。
    tone: direction === 'neutral' || Math.abs(value) < 1 ? 'neutral' : improves ? 'success' : 'error',
  };
}

export function projectDiff(rows: readonly SkillDiffRow[]): HealthDiffRow[] {
  return rows.map((row) => ({
    ...row,
    deltas: {
      segments: deltaOf(row.deltaSegments, 'neutral', false),
      gap: deltaOf(row.deltaGap, 'lower'),
      failure: deltaOf(row.deltaFailure, 'lower'),
      coverage: deltaOf(row.deltaCoverage, 'higher'),
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
        label: `${Math.round(value * 100)}%`,
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
