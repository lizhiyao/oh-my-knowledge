import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { renderSkillList } from '../renderer/skill-list-renderer.js';
import { renderSkillHealthReport } from '../renderer/skill-health-renderer.js';
import { renderDoctorDetail } from '../renderer/doctor-detail-renderer.js';
import type { SkillReportContext } from '../renderer/report-shell.js';
import { assessHealth, renderSkillDetail } from '../renderer/skill-detail-renderer.js';
import type { SkillIndexEntry, Insight } from '../types/skill-index.js';
import { renderObservationInboxPage } from '../renderer/observation-inbox-renderer.js';
import { renderKnowledgeDebuggerPage } from '../renderer/knowledge-debugger-renderer.js';
import {
  buildConversationActivitySnapshot,
  buildConversationDetailActivitySnapshot,
  renderConversationDetailPage,
  renderConversationIndexPage,
} from '../renderer/conversation-renderer.js';
import { DEFAULT_LANG, e, t, layout } from '../renderer/layout.js';
import { loadAllManagedRecords, resolveManagedDir, managedDir as projectManagedDir, listManagedRows } from '../managed/index.js';
import { renderManagedList, renderManagedHistory } from '../renderer/managed-history-renderer.js';
import { resolveObserveHealthDir, projectObserveHealthDir, resolveDoctorsDir, projectDoctorsDir } from '../measurement-artifacts/directories.js';
import { listObserveCards, listDoctorCards, listLiveObserveCards } from '../measurement-artifacts/discovery-index.js';
import { isReportFileName, reportFilePath, reportFileStem } from '../measurement-artifacts/file-names.js';
import { buildSkillIndex } from './skill-index.js';
import type { Lang } from '../types/index.js';
import type { DoctorReport } from '../doctor/contracts.js';
import { parseDoctorReport } from '../shared/doctor-report.js';
import {
  confidenceOf,
  toolStabilityOf,
  type SkillHealth,
  type SkillHealthReport,
} from '../observability/skill-health-analyzer.js';
import { parseSkillHealthReport } from '../observability/skill-health-report.js';
import { DEFAULT_OBSERVATIONS_DIR, findObservationInboxItem, formatObservationShow, queryObservationInbox } from '../observability/inbox.js';
import { buildObservationInboxViewModel } from '../observability/inbox-view-model.js';
import { buildKnowledgeDebuggerViewModel } from '../observability/knowledge-debugger.js';
import {
  createCodexConversationCatalog,
  type ConversationCatalog,
} from '../observability/conversation-catalog.js';
import {
  loadObservationSourceRecordArchive,
  summarizeObservationSourceRecordArchive,
} from '../observability/source-record-archive.js';
import { activeStudioDiagnostics } from '../diagnosis/studio-projection.js';
import {
  deleteObservationReviewState,
  loadObservationReviewState,
  ObservationReviewStateValidationError,
  updateObservationReviewState,
  type ObservationReviewStateUpdate,
} from '../observability/review-state.js';
import type { AddressInfo } from 'node:net';
import type { CoreStudioCatalog } from '../eval-workflows/studio-catalog/index.js';
import { createCoreStudioRouteHandler } from './core-studio-route-handler.js';

const DEFAULT_PORT = 7799;
const PORT_HINT = `OMK_REPORT_PORT=${DEFAULT_PORT} omk eval ...`;

interface ReportServerOptions {
  port?: number;
  /** 监听 host。默认 '127.0.0.1'(只允许本机访问,容器/远程场景看不到)。
   *  暴露到容器外 / 局域网用 '0.0.0.0'。也可走 OMK_REPORT_HOST 环境变量。 */
  host?: string;
  /** observe-health 报告目录(项目 .omk/observe-health 或全局),或一个按请求动态解析它的函数。
   *  传函数 → 每次请求重解析(长会话里项目首次 omk observe 后从 global 实时切回 project);
   *  传字符串 → 固定到该目录(测试 / 显式覆盖);默认动态解析 project→global 权威目录。 */
  analysesDir?: string | (() => string);
  /** 体检报告目录(项目 .omk/doctors 或全局),或一个按请求动态解析它的函数。三模式同 analysesDir。 */
  doctorsDir?: string | (() => string);
  observationsDir?: string;
  /** 受管目录(.omk/managed 或全局),或一个按请求动态解析它的函数。只读消费,供 /managed 决策史页。
   *  传函数 → 每次请求重解析(长会话里跟 omk list 同口径:项目首次 install 后从 global 实时切回 project);
   *  传字符串 → 固定到该目录(测试 / 显式覆盖);默认动态解析 project→global 权威目录。 */
  managedDir?: string | (() => string);
  /** Source-neutral conversation inventory. Defaults to the local Codex catalog. */
  conversationCatalog?: ConversationCatalog;
  /** Evaluation 页面唯一事实源。提供后，/reports 与 /api/reports 只读 Core artifacts。 */
  coreStudioCatalog?: CoreStudioCatalog;
  /** 是否把别项目的 observe-health 索引卡片合进列表 / 详情 / skill 首页(机器级总览)。
   *  默认 false(固定目录 / 测试 hermetic);studio 仅在「无 --analyses-dir 且无 --global」的默认机器级模式传 true。 */
  includeObserveCards?: boolean;
  /** 是否把别项目的 doctor 索引卡片合进 skill 首页 / 详情兜底(机器级总览)。
   *  默认 false;studio 仅在「无 --doctors-dir 且无 --global」的默认机器级模式传 true。 */
  includeDoctorCards?: boolean;
}

interface AnalysisListItem {
  id: string;
  generatedAt: string;
  sessionCount: number;
  segmentCount: number;
  skillCount: number;
  healthBand: 'green' | 'yellow' | 'red';
  confidence: 'high' | 'low' | 'underpowered';
}

let cachedChartJsBytes: string | null | undefined;
function loadChartJsBundle(): string | null {
  if (cachedChartJsBytes !== undefined) return cachedChartJsBytes;
  try {
    // chart.js 的 exports 字段不允许直接 resolve 子路径,先 resolve 主入口拿到包目录,
    // 再拼到 dist/chart.umd.min.js(这个 UMD 在 sideEffects 里声明,实际存在)。
    const req = createRequire(import.meta.url);
    const mainPath = req.resolve('chart.js');
    const distDir = mainPath.replace(/[/\\]chart\.cjs$/, '').replace(/[/\\]chart\.js$/, '');
    const umdPath = join(distDir, 'chart.umd.min.js');
    cachedChartJsBytes = readFileSync(umdPath, 'utf-8');
  } catch {
    cachedChartJsBytes = null;
  }
  return cachedChartJsBytes;
}

function listAnalyses(dir: string, includeCards = false): AnalysisListItem[] {
  const items: AnalysisListItem[] = [];
  // live 扫描 dir 存在才做;dir 不存在(默认机器级模式下当前项目还没 .omk/observe-health、全局也空)时 live 为空,
  // 但**不能早退** —— 后面仍要按 includeCards 合并别项目卡片,否则 observe 列表会与合卡片的 /api/skills 口径分裂。
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      const id = reportFileStem(file);
      if (!id) continue;
      try {
        const data = parseSkillHealthReport(JSON.parse(readFileSync(join(dir, file), 'utf-8')));
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
      } catch { /* skip corrupt */ }
    }
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

function loadAnalysis(dir: string, id: string, includeCards = false): SkillHealthReport | null {
  const path = reportFilePath(dir, id);
  if (existsSync(path)) {
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
function loadDoctorReport(dir: string, id: string, skillName?: string, includeCards = false): DoctorReport | null {
  let fallback: DoctorReport | null = null;
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!isReportFileName(file)) continue;
      try {
        const data = parseDoctorReport(JSON.parse(readFileSync(join(dir, file), 'utf-8')));
        if (!data || data.id !== id) continue;
        if (!skillName || data.skills?.some((s) => s.skillName === skillName)) return data;
        fallback ??= data;
      } catch { /* skip */ }
    }
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

interface SkillTrendPoint {
  analysisId: string;
  generatedAt: string;
  gapRate: number;
  weightedGapRate: number;
  failureRate: number | null;
  toolCallCount: number;
  toolResolvedCount: number;
  toolComparableCount: number;
  toolCancelledCount: number;
  toolOutcomeCoverage: number | null;
  coverageRate: number | null;
  /** input + output only, 计费主成本 */
  billableTokens: number;
  /** cache_read + cache_creation, 通常远大于 billable 但计费权重低 */
  cachedTokens: number;
  totalTokens: number;
  avgTokensPerSegment: number;
  tokenCoverage: number;
  durationMs: number;
  segmentCount: number;
  stability: 'stable' | 'unstable' | 'very-unstable' | 'unknown';
}

interface SkillTrendResult {
  skillName: string;
  points: SkillTrendPoint[];
}

/**
 * 扫 analyses/ 所有 JSON,按 skillName 过滤,按时间排序成 trend points。
 */
function querySkillTrend(dir: string, skillName: string, includeCards = false): SkillTrendResult {
  const items = listAnalyses(dir, includeCards);
  const points: SkillTrendPoint[] = [];
  for (const it of items) {
    const report = loadAnalysis(dir, it.id, includeCards);
    if (!report) continue;
    const h = report.bySkill[skillName];
    if (!h) continue;
    // 旧格式 (加 usage 字段前的 analysis) 用 safe access,缺字段降级为 0/undefined
    const u = h.usage;
    const billable = (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0);
    const cached = (u?.cacheReadTokens ?? 0) + (u?.cacheCreationTokens ?? 0);
    const toolCallCount = h.toolCallCount ?? 0;
    const toolResolvedCount = h.toolResolvedCount ?? toolCallCount;
    const toolCancelledCount = h.toolCancelledCount ?? 0;
    const toolComparableCount = Math.max(0, toolResolvedCount - toolCancelledCount);
    points.push({
      analysisId: it.id,
      generatedAt: report.meta.generatedAt,
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
    });
  }
  // 最旧在前,便于折线图从左到右展示时间序列
  points.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  return { skillName, points };
}

function measuredToolFailureRate(
  health: Pick<
    SkillHealth,
    'stability' | 'toolCallCount' | 'toolResolvedCount' | 'toolCancelledCount' | 'toolFailureRate'
  >,
): number | null {
  if (health.stability === 'unknown') return null;
  if (health.toolResolvedCount !== undefined || health.toolCancelledCount !== undefined) {
    const comparable = Math.max(
      0,
      (health.toolResolvedCount ?? health.toolCallCount) - (health.toolCancelledCount ?? 0),
    );
    return comparable > 0 ? health.toolFailureRate : null;
  }
  // Legacy reports predate toolResolvedCount but treated every recorded call as
  // resolved. Preserve those measured rates when a non-zero denominator exists.
  return health.toolCallCount > 0 ? health.toolFailureRate : null;
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

interface SkillDiffRow {
  skillName: string;
  presence: 'both' | 'only-from' | 'only-to';
  fromGap?: number;
  toGap?: number;
  deltaGap?: number;
  fromFailure?: number | null;
  toFailure?: number | null;
  deltaFailure?: number;
  fromCoverage?: number | null;
  toCoverage?: number | null;
  deltaCoverage?: number | null;
  fromSegments?: number;
  toSegments?: number;
  deltaSegments?: number;
}

interface SkillDiffResult {
  fromId: string;
  toId: string;
  fromAt: string;
  toAt: string;
  rows: SkillDiffRow[];
}

/**
 * 比较两份 skill health report. `from` 通常是较早的,`to` 是较晚的;
 * 对于每个 skill, 显示前后值和 delta. 缺失一侧时 presence 标记。
 */
function querySkillDiff(dir: string, fromId: string, toId: string, includeCards = false): SkillDiffResult | null {
  const from = loadAnalysis(dir, fromId, includeCards);
  const to = loadAnalysis(dir, toId, includeCards);
  if (!from || !to) return null;
  const allSkills = new Set<string>([...Object.keys(from.bySkill), ...Object.keys(to.bySkill)]);
  const rows: SkillDiffRow[] = [];
  for (const skill of allSkills) {
    const f = from.bySkill[skill];
    const t = to.bySkill[skill];
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

function fmtDelta(d: number | null | undefined, isPercent = true): string {
  if (d == null) return '—';
  const pct = isPercent ? d * 100 : d;
  const sign = pct > 0 ? '+' : '';
  const color = Math.abs(pct) < 1 ? '#888' : pct > 0 ? '#dc2626' : '#16a34a';
  return `<span style="color:${color}">${sign}${pct.toFixed(isPercent ? 1 : 0)}${isPercent ? '%' : ''}</span>`;
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${Math.round(v * 100)}%`;
}

class RequestBodyError extends Error {
  override readonly name = 'RequestBodyError';

  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 413 | 415,
  ) {
    super(message);
  }
}

function assertTrustedMutationRequest(req: IncomingMessage): void {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') {
    throw new RequestBodyError('cross-origin mutation is not allowed', 403);
  }

  const origin = req.headers.origin;
  if (!origin) return;
  if (Array.isArray(origin) || !req.headers.host) {
    throw new RequestBodyError('cross-origin mutation is not allowed', 403);
  }
  try {
    if (new URL(origin).host !== req.headers.host) {
      throw new RequestBodyError('cross-origin mutation is not allowed', 403);
    }
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError('cross-origin mutation is not allowed', 403);
  }
}

function assertJsonContentType(req: IncomingMessage): void {
  const contentType = req.headers['content-type'];
  const mediaType = typeof contentType === 'string'
    ? contentType.split(';', 1)[0].trim().toLowerCase()
    : '';
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) return;
  req.resume();
  throw new RequestBodyError('content-type must be application/json', 415);
}

function readJsonObjectBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  assertJsonContentType(req);
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new RequestBodyError('request body too large', 413));
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        const parsed = raw ? JSON.parse(raw) as unknown : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new RequestBodyError('json body must be an object', 400));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new RequestBodyError('invalid json body', 400));
      }
    });
    req.on('error', reject);
  });
}

function fmtHistDate(ts: string | undefined, lang: Lang): string {
  if (!ts) return '-';
  try {
    const d = new Date(ts);
    return d.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return ts; }
}

// Doctor 详情只链接 doctor／observe 独立事实源。Evaluation 由 Core Studio 单独呈现。
function buildSkillContext(entry: SkillIndexEntry, currentReportId: string, insights: Insight[], lang: Lang): SkillReportContext {
  const zh = lang === 'zh';
  const amp = lang === DEFAULT_LANG ? '' : `&lang=${lang}`;
  type Band = 'green' | 'yellow' | 'red' | 'gray';
  const health = assessHealth(entry, insights, lang);
  const doctor = entry.doctor;
  const doctorBand: Band = doctor
    ? doctor.failCount > 0 ? 'red' : doctor.warnCount > 0 ? 'yellow' : 'green'
    : 'gray';
  const observe = entry.observe;
  const observeTrustworthy = observe !== null && observe.confidence !== 'underpowered';
  const observeBand: Band = observeTrustworthy ? observe.healthBand : 'gray';
  const history = [...entry.doctorHistory].reverse().map((snapshot) => {
    const total = snapshot.passCount + snapshot.warnCount + snapshot.failCount;
    return {
      dim: 'doctor' as const,
      dateText: fmtHistDate(snapshot.timestamp, lang),
      scoreText: total > 0 ? String(Math.round(((snapshot.passCount + snapshot.warnCount * 0.5) / total) * 100)) : '—',
      band: (snapshot.failCount > 0 ? 'red' : snapshot.warnCount > 0 ? 'yellow' : 'green') as Band,
      metaText: `${snapshot.passCount}✓ ${snapshot.warnCount}⚠ ${snapshot.failCount}✗`,
      href: `/doctors/${encodeURIComponent(snapshot.reportId)}?skill=${encodeURIComponent(entry.skillName)}${amp}`,
      current: snapshot.reportId === currentReportId,
    };
  });
  return {
    skillName: entry.skillName,
    overall: { score: health.score, band: health.color },
    chips: [
      { dim: 'doctor', label: zh ? '体检' : 'Doctor', score: null, band: doctorBand, href: null, active: true },
      { dim: 'observe', label: zh ? '观察' : 'Observe', score: observeTrustworthy ? Math.round((1 - observe.gapRate) * 100) : null, band: observeBand, href: null, active: false },
    ],
    history,
  };
}

function renderSkillDiffPage(diff: SkillDiffResult, lang: Lang = DEFAULT_LANG): string {
  const { fromId, toId, fromAt, toAt, rows } = diff;
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  const rowHtml = rows.map((r) => {
    const tag = r.presence === 'only-from' ? `<span style="color:var(--green);font-size:10px;padding:1px 6px;background:var(--green-bg);border-radius:3px" data-i18n="diffTagRemoved">${t('diffTagRemoved', lang)}</span>`
      : r.presence === 'only-to' ? `<span style="color:var(--accent);font-size:10px;padding:1px 6px;background:var(--info-bg);border-radius:3px" data-i18n="diffTagNew">${t('diffTagNew', lang)}</span>`
      : '';
    return `<tr>
      <td style="padding:8px 10px;font-family:ui-monospace,monospace">${e(r.skillName)} ${tag}</td>
      <td style="padding:8px 10px;text-align:right">${r.fromSegments ?? '—'} → ${r.toSegments ?? '—'} ${r.presence === 'both' ? `(${fmtDelta(r.deltaSegments, false)})` : ''}</td>
      <td style="padding:8px 10px;text-align:right">${fmtPct(r.fromGap)} → ${fmtPct(r.toGap)} ${r.presence === 'both' ? fmtDelta(r.deltaGap) : ''}</td>
      <td style="padding:8px 10px;text-align:right">${fmtPct(r.fromFailure)} → ${fmtPct(r.toFailure)} ${r.presence === 'both' ? fmtDelta(r.deltaFailure) : ''}</td>
      <td style="padding:8px 10px;text-align:right">${fmtPct(r.fromCoverage)} → ${fmtPct(r.toCoverage)} ${r.presence === 'both' && r.deltaCoverage != null ? fmtDelta(r.deltaCoverage) : ''}</td>
    </tr>`;
  }).join('');
  const body = `
    <main style="max-width:1000px;margin:0 auto;padding:24px">
      <nav style="margin-bottom:8px">
        <a href="/observe-health${langQ}" data-i18n="backToAnalyses" style="color:var(--accent);text-decoration:none;margin-right:12px">${t('backToAnalyses', lang)}</a>
        <a href="/observe-health/${encodeURIComponent(fromId)}${langQ}" data-i18n="diffNavFrom" style="color:var(--accent);text-decoration:none;margin-right:12px">${t('diffNavFrom', lang)}</a>
        <a href="/observe-health/${encodeURIComponent(toId)}${langQ}" data-i18n="diffNavTo" style="color:var(--accent);text-decoration:none">${t('diffNavTo', lang)}</a>
      </nav>
      <h1 data-i18n="skillDiffHeading" style="font-size:20px;margin:8px 0">${t('skillDiffHeading', lang)}</h1>
      <div style="color:var(--text-muted);font-size:13px;margin-bottom:20px">
        <span data-i18n="diffNavFrom">${t('diffNavFrom', lang)}</span> <code>${e(fromId)}</code> (${e(fromAt.slice(0, 19).replace('T', ' '))}) → <span data-i18n="diffNavTo">${t('diffNavTo', lang)}</span> <code>${e(toId)}</code> (${e(toAt.slice(0, 19).replace('T', ' '))})<br/>
        <span data-i18n="diffSortHint">${t('diffSortHint', lang)}</span>
      </div>
      <table style="border-collapse:collapse;width:100%;font-size:13px">
        <thead><tr>
          <th style="text-align:left;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColSkill">${t('diffColSkill', lang)}</th>
          <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColSegments">${t('diffColSegments', lang)}</th>
          <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColWeightedGap">${t('diffColWeightedGap', lang)}</th>
          <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColFailureRate">${t('diffColFailureRate', lang)}</th>
          <th style="text-align:right;padding:10px;border-bottom:2px solid var(--border);font-weight:600" data-i18n="diffColCoverage">${t('diffColCoverage', lang)}</th>
        </tr></thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </main>`;
  return layout(t('skillDiffHeading', lang), body, lang);
}

function renderSkillTrendPage(trend: SkillTrendResult, lang: Lang = DEFAULT_LANG): string {
  const { skillName, points } = trend;
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  if (points.length === 0) {
    const emptyBody = `
    <main style="max-width:900px;margin:0 auto;padding:24px">
      <nav style="margin-bottom:12px"><a href="/observe-health${langQ}" data-i18n="backToAnalyses" style="color:var(--accent);text-decoration:none">${t('backToAnalyses', lang)}</a></nav>
      <h1 style="font-size:20px;margin:8px 0 4px"><span data-i18n="skillTrendHeading">${t('skillTrendHeading', lang)}</span> · ${e(skillName)}</h1>
      <p style="color:var(--text-muted)" data-i18n="noTrendData">${t('noTrendData', lang)}</p>
    </main>`;
    return layout(`${t('skillTrendHeading', lang)} · ${skillName}`, emptyBody, lang);
  }
  // SVG 折线图: gapRate 主线 + failureRate 辅线, X 轴时间序
  const W = 760, H = 200, PAD = 40;
  const toX = (i: number) => points.length === 1 ? W / 2 : PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const toY = (v: number) => H - PAD - v * (H - 2 * PAD);
  const pathOf = (key: 'gapRate' | 'weightedGapRate' | 'failureRate' | 'coverageRate') => {
    const usable = points.map((p, i) => ({ x: toX(i), y: p[key] ?? null }));
    let d = '';
    let drawing = false;
    for (const pt of usable) {
      if (pt.y == null) {
        drawing = false;
        continue;
      }
      d += drawing ? ` L ${pt.x} ${toY(pt.y as number)}` : `M ${pt.x} ${toY(pt.y as number)}`;
      drawing = true;
    }
    return d;
  };
  const dots = (key: 'gapRate' | 'weightedGapRate' | 'failureRate' | 'coverageRate', color: string) =>
    points.map((p, i) => p[key] == null ? '' : `<circle cx="${toX(i)}" cy="${toY(p[key] as number)}" r="3" fill="${color}"/>`).join('');
  const yTicks = [0, 0.5, 1.0].map((v) => `<g><line x1="${PAD}" y1="${toY(v)}" x2="${W - PAD}" y2="${toY(v)}" stroke="var(--border)"/><text x="${PAD - 6}" y="${toY(v) + 4}" text-anchor="end" font-size="11" fill="var(--text-muted)">${Math.round(v * 100)}%</text></g>`).join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;height:${H}px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius)">
    ${yTicks}
    <path d="${pathOf('gapRate')}" stroke="#f87171" stroke-width="2" fill="none"/>
    <path d="${pathOf('weightedGapRate')}" stroke="#fbbf24" stroke-width="2" fill="none" stroke-dasharray="4 4"/>
    <path d="${pathOf('failureRate')}" stroke="#a78bfa" stroke-width="2" fill="none"/>
    <path d="${pathOf('coverageRate')}" stroke="#4ade80" stroke-width="2" fill="none"/>
    ${dots('gapRate', '#f87171')}${dots('weightedGapRate', '#fbbf24')}${dots('failureRate', '#a78bfa')}${dots('coverageRate', '#4ade80')}
  </svg>`;
  const legend = `<div style="margin:12px 0;font-size:12px;color:var(--text-secondary)">
    <span style="color:#f87171">● <span data-i18n="trendLegendGap">${t('trendLegendGap', lang)}</span></span> ·
    <span style="color:#fbbf24">◆ <span data-i18n="trendLegendWeighted">${t('trendLegendWeighted', lang)}</span></span> ·
    <span style="color:#a78bfa">● <span data-i18n="trendLegendFailure">${t('trendLegendFailure', lang)}</span></span> ·
    <span style="color:#4ade80">● <span data-i18n="trendLegendCoverage">${t('trendLegendCoverage', lang)}</span></span>
  </div>`;
  const rows = points.map((p) => {
    const failureCell = p.failureRate == null
      ? '—'
      : `${Math.round(p.failureRate * 100)}%${p.toolCallCount > 0
        ? `<br><span style="color:var(--text-muted);font-size:11px">${p.toolComparableCount}/${p.toolCallCount} ${lang === 'zh' ? '结果可比较' : 'comparable'}${p.toolCancelledCount > 0 ? ` · ${p.toolCancelledCount} ${lang === 'zh' ? '取消' : 'cancelled'}` : ''}</span>`
        : ''}`;
    return `<tr>
    <td style="padding:6px 10px;font-family:ui-monospace,monospace;font-size:12px"><a href="/observe-health/${encodeURIComponent(p.analysisId)}${langQ}" style="color:var(--accent);text-decoration:none">${e(p.generatedAt.slice(0, 19).replace('T', ' '))}</a></td>
    <td style="padding:6px 10px;text-align:right">${p.segmentCount}</td>
    <td style="padding:6px 10px;text-align:right;color:#f87171">${Math.round(p.gapRate * 100)}%</td>
    <td style="padding:6px 10px;text-align:right;color:#fbbf24">${Math.round(p.weightedGapRate * 100)}%</td>
    <td style="padding:6px 10px;text-align:right;color:#a78bfa">${failureCell}</td>
    <td style="padding:6px 10px;text-align:right;color:#4ade80">${p.coverageRate == null ? '—' : Math.round(p.coverageRate * 100) + '%'}</td>
    <td style="padding:6px 10px;text-align:right;font-family:ui-monospace,monospace;font-size:12px" title="input+output only; cache 分开计">${(p.billableTokens / 1000).toFixed(1)}k</td>
    <td style="padding:6px 10px;text-align:right;font-family:ui-monospace,monospace;font-size:12px">${(p.durationMs / 1000).toFixed(1)}s</td>
  </tr>`;
  }).join('');
  const subtitle = `${points.length} <span data-i18n="trendNPoints">${t('trendNPoints', lang)}</span> · <span data-i18n="trendEarliest">${t('trendEarliest', lang)}</span> ${e(points[0].generatedAt.slice(0, 10))} · <span data-i18n="trendLatest">${t('trendLatest', lang)}</span> ${e(points[points.length - 1].generatedAt.slice(0, 10))}`;
  const body = `
    <main style="max-width:900px;margin:0 auto;padding:24px">
      <nav style="margin-bottom:8px"><a href="/observe-health${langQ}" data-i18n="backToAnalyses" style="color:var(--accent);text-decoration:none">${t('backToAnalyses', lang)}</a></nav>
      <h1 style="font-size:20px;margin:8px 0 4px"><span data-i18n="skillTrendHeading">${t('skillTrendHeading', lang)}</span> · ${e(skillName)}</h1>
      <div style="color:var(--text-muted);font-size:13px;margin-bottom:16px">${subtitle}</div>
      ${svg}
      ${legend}
      <table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:12px">
        <thead><tr>
          <th style="text-align:left;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColTimestamp">${t('trendColTimestamp', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColSegs">${t('trendColSegs', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColGap">${t('trendColGap', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColWeighted">${t('trendColWeighted', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColFailure">${t('trendColFailure', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColCoverage">${t('trendColCoverage', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColTokens">${t('trendColTokens', lang)}</th>
          <th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--border);color:var(--text-secondary);font-weight:600" data-i18n="trendColDuration">${t('trendColDuration', lang)}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </main>`;
  return layout(`${t('skillTrendHeading', lang)} · ${skillName}`, body, lang);
}

function renderAnalysisList(items: AnalysisListItem[], lang: Lang = DEFAULT_LANG): string {
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  const body = items.length === 0
    ? `
    <main style="max-width:900px;margin:0 auto;padding:24px">
      <nav style="margin-bottom:12px"><a href="/${langQ}" data-i18n="backToEvalReports" style="color:var(--accent);text-decoration:none">${t('backToEvalReports', lang)}</a></nav>
      <h1 data-i18n="skillHealthTitle" style="font-size:20px;margin:8px 0 16px">${t('skillHealthTitle', lang)}</h1>
      <div style="color:var(--text-muted);padding:16px" data-i18n="noAnalyses">${t('noAnalyses', lang)}</div>
    </main>`
    : (() => {
      const rows = items.map((it) => {
        // 低 N 报告的色带仅供参考:列表入口圆点改中性灰,避免点进去才看到「样本不足」的口径错位。
        const underpowered = it.confidence === 'underpowered';
        const badgeColor = underpowered
          ? 'var(--text-faint)'
          : it.healthBand === 'red' ? 'var(--red)' : it.healthBand === 'yellow' ? 'var(--yellow)' : 'var(--green)';
        const enc = encodeURIComponent(it.id);
        return `<li style="padding:10px 14px;border-bottom:1px solid var(--border);list-style:none;display:flex;align-items:center;gap:12px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${badgeColor}"></span>
          <label style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:3px"><input type="radio" name="from" value="${enc}" onchange="updateCompare()"> <span data-i18n="analysesFromLabel">${t('analysesFromLabel', lang)}</span></label>
          <label style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:3px"><input type="radio" name="to" value="${enc}" onchange="updateCompare()"> <span data-i18n="analysesToLabel">${t('analysesToLabel', lang)}</span></label>
          <a href="/observe-health/${enc}${langQ}" style="color:var(--accent);text-decoration:none;flex:1;font-family:ui-monospace,monospace">${it.id}</a>
          <span style="color:var(--text-muted);font-size:12px">${it.sessionCount} <span data-i18n="analysesSessions">${t('analysesSessions', lang)}</span> · ${it.segmentCount} <span data-i18n="analysesSegs">${t('analysesSegs', lang)}</span> · ${it.skillCount} <span data-i18n="analysesSkills">${t('analysesSkills', lang)}</span>${underpowered ? ` · <span data-i18n="analysesLowN" style="color:var(--text-faint)">${t('analysesLowN', lang)}</span>` : ''}</span>
        </li>`;
      }).join('');
      return `
      <main style="max-width:900px;margin:0 auto;padding:24px">
        <nav style="margin-bottom:12px"><a href="/${langQ}" data-i18n="backToEvalReports" style="color:var(--accent);text-decoration:none">${t('backToEvalReports', lang)}</a></nav>
        <h1 data-i18n="skillHealthTitle" style="font-size:20px;margin:8px 0 16px">${t('skillHealthTitle', lang)}</h1>
        <div style="margin-bottom:12px;padding:8px 12px;background:var(--bg-surface);border-radius:var(--radius);font-size:12px;color:var(--text-secondary)">
          <span data-i18n="analysesCompareHint">${t('analysesCompareHint', lang)}</span>
          <a id="compare-btn" style="margin-left:8px;padding:4px 10px;background:var(--accent);color:white;text-decoration:none;border-radius:3px;opacity:0.4;pointer-events:none" data-i18n="analysesCompareBtn">${t('analysesCompareBtn', lang)}</a>
        </div>
        <ul style="padding:0;margin:0;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">${rows}</ul>
      </main>
      <script>
        function updateCompare() {
          var f = document.querySelector('input[name=from]:checked');
          var t2 = document.querySelector('input[name=to]:checked');
          var btn = document.getElementById('compare-btn');
          if (f && t2 && f.value !== t2.value) {
            btn.href = '/analyses-diff?from=' + f.value + '&to=' + t2.value + '&lang=' + (document.documentElement.dataset.lang || '${DEFAULT_LANG}');
            btn.style.opacity = '1';
            btn.style.pointerEvents = 'auto';
          } else {
            btn.removeAttribute('href');
            btn.style.opacity = '0.4';
            btn.style.pointerEvents = 'none';
          }
        }
      </script>`;
    })();
  return layout(t('skillHealthTitle', lang), body, lang);
}

interface ReportServer {
  start(): Promise<string>;
  stop(): Promise<void>;
  getUrl(): string | null;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Returns Error to throw, or null when caller should fall through to the
// EADDRINUSE / omk-takeover flow. Splits "occupancy" from "permission" /
// "ephemeral-bind-rejected" so users see a fix path that matches the cause.
export function formatListenError(p: number, err: unknown): Error | null {
  const errno = (err as NodeJS.ErrnoException | undefined)?.code;

  // p === 0 asks the OS to pick an ephemeral port; "already in use" is
  // semantically wrong here. Failures are almost always sandbox / restricted
  // network environments rather than occupancy.
  if (p === 0) {
    return new Error(
      `cannot bind ephemeral port (--port 0): ${errno ?? 'unknown error'}.\n` +
      `  likely cause: sandboxed / restricted network environment ` +
      `(Docker without --net=host, container without bind permission).\n` +
      `  try a fixed port: ${PORT_HINT}`
    );
  }

  // EACCES / EPERM: permission, not occupancy. Common on privileged ports
  // (<1024 without root) or sandbox / container restrictions.
  if (errno === 'EACCES' || errno === 'EPERM') {
    return new Error(
      `cannot bind port ${p}: permission denied (${errno}).\n` +
      `  ports < 1024 require root on Unix; sandboxed environments may block all binds.\n` +
      `  pick another unblocked port: ${PORT_HINT}`
    );
  }

  // Any other syscall errno that isn't EADDRINUSE: surface it directly,
  // don't try the omk-takeover flow.
  if (errno && errno !== 'EADDRINUSE') {
    return new Error(
      `cannot bind port ${p}: ${errno} (${getErrorMessage(err)}).\n` +
      `  pick another port: ${PORT_HINT}`
    );
  }

  // EADDRINUSE or unknown — let caller try the omk-takeover flow.
  return null;
}

function findKnowledgeDebuggerContext(observationsDir: string, experienceSessionId: string) {
  const inbox = buildObservationInboxViewModel(observationsDir);
  const report = inbox.reports.find((candidate) =>
    candidate.experience?.sessions.some((session) => session.id === experienceSessionId)
  );
  const session = report?.experience?.sessions.find((candidate) => candidate.id === experienceSessionId);
  if (!report || !session) return undefined;
  const sourceRecordRef = report.meta.sourceRecordArchives?.find((candidate) =>
    candidate.experienceSessionId === experienceSessionId
  );
  return { report, session, sourceRecordRef };
}

export function createReportServer({ port, host: hostOption, analysesDir, doctorsDir, observationsDir = DEFAULT_OBSERVATIONS_DIR, managedDir, conversationCatalog, coreStudioCatalog, includeObserveCards = false, includeDoctorCards = false }: ReportServerOptions = {}): ReportServer {
  let server: Server | null = null;
  let serverUrl: string | null = null;
  const liveStreamClosers = new Set<() => void>();

  const resolvedConversationCatalog = conversationCatalog ?? createCodexConversationCatalog();
  const coreStudioRoute = coreStudioCatalog === undefined
    ? undefined
    : createCoreStudioRouteHandler({
        catalog: coreStudioCatalog,
        htmlBasePath: '/reports',
        apiBasePath: '/api/reports',
        defaultLang: DEFAULT_LANG,
      });
  // 受管根目录按**请求**解析,不在启动时冻结 —— 否则长会话里会跟 omk list 分叉:Studio 启动时项目 .omk/managed
  // 还空、回退到 global,随后用户在项目里首次 omk install,omk list 下次会切到 project,而冻结了 root 的 Studio
  // 仍盯着旧 global,页面与 CLI 不一致。cwd 在进程内不变,变的是目录里有没有记录,故每次请求重判。
  //   - 传函数 → 直接当解析器,每次请求调用(测试可注入受控解析器复现 project↔global 切换);
  //   - 传字符串 → 固定该目录(显式覆盖 / 测试);
  //   - 缺省 → 动态解析 project→global 权威目录,与 omk list 同口径。
  const resolveManagedRoot: () => string =
    typeof managedDir === 'function'
      ? managedDir
      : managedDir !== undefined
        ? (): string => managedDir
        : (): string => resolveManagedDir(projectManagedDir());

  // observe-health 目录同 managed 按**请求**解析(项目 .omk/observe-health 优先、空则全局兜底) ——
  // 长会话里项目首次 omk observe 后,studio 下次请求即从 global 切回 project,不在启动时冻结。
  // 三模式同 managedDir:函数透传 / 字符串固定 / 缺省动态解析。
  const resolveAnalysesDir: () => string =
    typeof analysesDir === 'function'
      ? analysesDir
      : analysesDir !== undefined
        ? (): string => analysesDir
        : (): string => resolveObserveHealthDir(projectObserveHealthDir());

  // doctors 目录同 analyses 按请求解析(项目优先→全局兜底),三模式同 managedDir / analysesDir。
  const resolveDoctorsRoot: () => string =
    typeof doctorsDir === 'function'
      ? doctorsDir
      : doctorsDir !== undefined
        ? (): string => doctorsDir
        : (): string => resolveDoctorsDir(projectDoctorsDir());

  const skillIndexOptions = (): Parameters<typeof buildSkillIndex>[3] => ({
    includeObserveCards,
    includeDoctorCards,
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      const path = parsed.pathname;
      try {
        decodeURIComponent(path);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      const langParam = parsed.searchParams.get('lang');
      const lang: Lang = langParam === 'en' ? 'en' : langParam === 'zh' ? 'zh' : DEFAULT_LANG;

      if (coreStudioRoute !== undefined) {
        if (path === '/') {
          res.writeHead(302, { Location: `/reports${parsed.search}` });
          res.end();
          return;
        }
        const coreResponse = await coreStudioRoute({ method: req.method, url: req.url });
        if (coreResponse !== undefined) {
          res.writeHead(coreResponse.status, coreResponse.headers);
          res.end(coreResponse.body);
          return;
        }
      }

      // observe-health / doctors 目录每请求解析一次(项目优先→全局兜底),下面各 handler 用这两个 local 字符串。
      const analysesDir = resolveAnalysesDir();
      const doctorsDir = resolveDoctorsRoot();

      if (path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'omk' }));
        return;
      }

      // 静态资源:chart.js UMD bundle(供详情页趋势大图使用)。
      // 用 require.resolve 拿包路径,避开 dist 相对路径脆弱性。
      if (path === '/static/chart.js') {
        const bytes = loadChartJsBundle();
        if (!bytes) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('chart.js asset unavailable');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
        res.end(bytes);
        return;
      }

      if (path === '/api/shutdown' && req.method === 'POST') {
        assertTrustedMutationRequest(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        // Graceful shutdown after response sent
        setTimeout(() => {
          for (const close of [...liveStreamClosers]) close();
          if (server) server.close();
        }, 100);
        return;
      }

      // 旧 observe 路由 → observe-* 词根 canonical 的兜底(querystring 透传),防外链 / 书签 / 已打开页面的旧 fetch 失效。
      // 页面用 302(临时);API 用 307 —— review-state 有 POST/DELETE,302 会被客户端降级成 GET,307 保留 method+body。
      // 复合名 /analyses-diff、/api/analyses-diff、/skill-trend 维持原名,不在此重定向。
      const legacyObserveRedirect = ((): { to: string; status: 302 | 307 } | null => {
        if (path === '/analyses') return { to: '/observe-health', status: 302 };
        if (path === '/observations' || path === '/observations/inbox') return { to: '/observe-inbox', status: 302 };
        const detail = path.match(/^\/analyses\/(.+)$/);
        if (detail) return { to: `/observe-health/${detail[1]}`, status: 302 };
        if (path === '/api/analyses') return { to: '/api/observe-health', status: 307 };
        const apiDetail = path.match(/^\/api\/analyses\/(.+)$/);
        if (apiDetail) return { to: `/api/observe-health/${apiDetail[1]}`, status: 307 };
        if (path === '/api/observations/inbox') return { to: '/api/observe-inbox', status: 307 };
        if (path === '/api/observations/show') return { to: '/api/observe-inbox/show', status: 307 };
        if (path === '/api/observations/diagnostics') return { to: '/api/observe-inbox/diagnostics', status: 307 };
        if (path === '/api/observations/review-state') return { to: '/api/observe-inbox/review-state', status: 307 };
        return null;
      })();
      if (legacyObserveRedirect) {
        res.writeHead(legacyObserveRedirect.status, { Location: legacyObserveRedirect.to + parsed.search });
        res.end();
        return;
      }

      if (path === '/api/observe-health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(listAnalyses(analysesDir, includeObserveCards)));
        return;
      }

      if (path === '/observe-health') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderAnalysisList(listAnalyses(analysesDir, includeObserveCards), lang));
        return;
      }

      // 受管 skill 决策史（#203 管理支柱可视化出口）。只读受管记录,口径同 omk list。
      if (path === '/api/managed') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ schemaVersion: 1, rows: listManagedRows(resolveManagedRoot()) }));
        return;
      }

      if (path === '/managed') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderManagedList(listManagedRows(resolveManagedRoot()), lang));
        return;
      }

      const managedDetailMatch = path.match(/^\/managed\/(.+)$/);
      if (managedDetailMatch) {
        let id: string;
        try { id = decodeURIComponent(managedDetailMatch[1]); } catch { id = ''; }
        // 按稳定 id(= hash(kind, name)) 精确查 —— 同名不同 kind(skill/review vs prompt/review)各有独立 id,
        // 不会串到同一页;且只在已加载、已校验的记录里查,不拼文件路径、无路径穿越。
        const record = id ? loadAllManagedRecords(resolveManagedRoot()).find((r) => r.id === id) : undefined;
        if (!record) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(lang === 'en' ? 'managed record not found' : '受管记录不存在');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderManagedHistory(record, lang));
        return;
      }

      if (path === '/observe-inbox') {
        const skill = parsed.searchParams.get('skill') || undefined;
        const html = renderObservationInboxPage(buildObservationInboxViewModel(observationsDir, { skill }), lang);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (path === '/api/conversations/activity') {
        const snapshot = buildConversationActivitySnapshot(
          await resolvedConversationCatalog.listConversations(),
        );
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(snapshot));
        return;
      }

      const conversationActivityMatch = path.match(/^\/api\/conversations\/([^/]+)\/activity$/);
      if (conversationActivityMatch) {
        let threadId = '';
        try { threadId = decodeURIComponent(conversationActivityMatch[1]); } catch { /* invalid path */ }
        const conversation = threadId ? await resolvedConversationCatalog.getConversation(threadId) : undefined;
        if (!conversation) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'conversation_not_found' }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(buildConversationDetailActivitySnapshot(conversation)));
        return;
      }

      if (path === '/conversations') {
        const html = renderConversationIndexPage(await resolvedConversationCatalog.listConversations(), lang);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
      }

      const conversationTaskLiveMatch = path.match(/^\/api\/conversations\/([^/]+)\/tasks\/([^/]+)\/live$/);
      if (conversationTaskLiveMatch) {
        let threadId = '';
        let turnId = '';
        try {
          threadId = decodeURIComponent(conversationTaskLiveMatch[1]);
          turnId = decodeURIComponent(conversationTaskLiveMatch[2]);
        } catch { /* invalid path */ }
        const initial = threadId && turnId
          ? await resolvedConversationCatalog.loadTaskTrajectory(threadId, turnId)
          : undefined;
        if (!initial) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'task_trajectory_not_found' }));
          return;
        }
        if (!resolvedConversationCatalog.observeTaskTrajectory) {
          res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'live_task_trajectory_unavailable' }));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();

        let closed = false;
        let unsubscribe: (() => void) | undefined;
        const lifecycle = new AbortController();
        const heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n');
        }, 15_000);
        heartbeat.unref?.();
        const close = (): void => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          lifecycle.abort();
          unsubscribe?.();
          liveStreamClosers.delete(close);
          if (!res.destroyed && !res.writableEnded) res.end();
        };
        liveStreamClosers.add(close);
        req.once('close', close);
        res.once('close', close);

        try {
          unsubscribe = await resolvedConversationCatalog.observeTaskTrajectory(
            threadId,
            turnId,
            {
              next: (trajectory) => {
                if (closed || res.destroyed || res.writableEnded) return;
                res.write(`id: ${trajectory.revision}\n`);
                res.write('event: trajectory\n');
                res.write(`data: ${JSON.stringify({
                  revision: trajectory.revision,
                  status: trajectory.status,
                  liveObservable: trajectory.liveObservable,
                })}\n\n`);
              },
              complete: close,
              error: (cause) => {
                if (!closed && !res.destroyed && !res.writableEnded) {
                  res.write('event: trajectory-error\n');
                  res.write(`data: ${JSON.stringify({ error: getErrorMessage(cause) })}\n\n`);
                }
                close();
              },
            },
            { signal: lifecycle.signal },
          );
          if (closed) unsubscribe();
        } catch (cause) {
          if (!closed && !res.destroyed && !res.writableEnded) {
            res.write('event: trajectory-error\n');
            res.write(`data: ${JSON.stringify({ error: getErrorMessage(cause) })}\n\n`);
          }
          close();
        }
        return;
      }

      const conversationTaskMatch = path.match(/^\/conversations\/([^/]+)\/tasks\/([^/]+)$/);
      if (conversationTaskMatch) {
        let threadId = '';
        let turnId = '';
        try {
          threadId = decodeURIComponent(conversationTaskMatch[1]);
          turnId = decodeURIComponent(conversationTaskMatch[2]);
        } catch { /* invalid path */ }
        const trajectory = threadId && turnId
          ? await resolvedConversationCatalog.loadTaskTrajectory(threadId, turnId)
          : undefined;
        if (!trajectory) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(lang === 'en' ? 'task trajectory not found' : '任务轨迹不存在');
          return;
        }
        const sourceRecords = {
          ...trajectory.sourceRecords,
          records: [],
        };
        const html = renderKnowledgeDebuggerPage(
          buildKnowledgeDebuggerViewModel(
            trajectory.session,
            turnId,
            trajectory.ingestion,
            sourceRecords,
          ),
          lang,
          {
            sourceRecordsEndpoint: `/api/conversations/${encodeURIComponent(threadId)}/tasks/${encodeURIComponent(turnId)}/source-records`,
            ...(trajectory.liveObservable && resolvedConversationCatalog.observeTaskTrajectory ? {
              live: {
                endpoint: `/api/conversations/${encodeURIComponent(threadId)}/tasks/${encodeURIComponent(turnId)}/live`,
                revision: trajectory.revision,
              },
            } : {}),
          },
        );
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
      }

      const conversationTaskSourceMatch = path.match(/^\/api\/conversations\/([^/]+)\/tasks\/([^/]+)\/source-records$/);
      if (conversationTaskSourceMatch) {
        let threadId = '';
        let turnId = '';
        try {
          threadId = decodeURIComponent(conversationTaskSourceMatch[1]);
          turnId = decodeURIComponent(conversationTaskSourceMatch[2]);
        } catch { /* invalid path */ }
        const trajectory = threadId && turnId
          ? await resolvedConversationCatalog.loadTaskTrajectory(threadId, turnId)
          : undefined;
        if (!trajectory) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'task_trajectory_not_found' }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(trajectory.sourceRecords));
        return;
      }

      const conversationDetailMatch = path.match(/^\/conversations\/([^/]+)$/);
      if (conversationDetailMatch) {
        let threadId = '';
        try { threadId = decodeURIComponent(conversationDetailMatch[1]); } catch { /* invalid path */ }
        const conversation = threadId ? await resolvedConversationCatalog.getConversation(threadId) : undefined;
        if (!conversation) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(lang === 'en' ? 'conversation not found' : '对话不存在');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(renderConversationDetailPage(conversation, lang));
        return;
      }

      const knowledgeDebuggerMatch = path.match(/^\/observe-debugger\/(.+)$/);
      if (knowledgeDebuggerMatch) {
        let experienceSessionId = '';
        try { experienceSessionId = decodeURIComponent(knowledgeDebuggerMatch[1]); } catch { /* invalid path */ }
        const context = experienceSessionId
          ? findKnowledgeDebuggerContext(observationsDir, experienceSessionId)
          : undefined;
        if (!context) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(lang === 'en' ? 'experience session not found' : '观测会话不存在');
          return;
        }
        const targetTurnId = parsed.searchParams.get('turnId')?.trim();
        if (!targetTurnId) {
          const langQuery = lang === DEFAULT_LANG ? '' : '?lang=en';
          res.writeHead(302, {
            Location: `/conversations/${encodeURIComponent(context.session.threadId)}${langQuery}`,
          });
          res.end();
          return;
        }
        if (!context.session.turns.some((turn) => turn.turnId === targetTurnId)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(lang === 'en' ? 'task turn not found' : '任务不存在');
          return;
        }
        const html = renderKnowledgeDebuggerPage(
          buildKnowledgeDebuggerViewModel(
            context.session,
            targetTurnId,
            context.report.meta.ingestion,
            summarizeObservationSourceRecordArchive(context.sourceRecordRef),
          ),
          lang,
          {
            sourceRecordsEndpoint: `/api/observe-debugger/${encodeURIComponent(experienceSessionId)}/source-records`,
          },
        );
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      const knowledgeDebuggerSourceMatch = path.match(/^\/api\/observe-debugger\/(.+)\/source-records$/);
      if (knowledgeDebuggerSourceMatch) {
        let experienceSessionId = '';
        try { experienceSessionId = decodeURIComponent(knowledgeDebuggerSourceMatch[1]); } catch { /* invalid path */ }
        const context = experienceSessionId
          ? findKnowledgeDebuggerContext(observationsDir, experienceSessionId)
          : undefined;
        if (!context) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'experience_session_not_found' }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(loadObservationSourceRecordArchive(context.sourceRecordRef, observationsDir)));
        return;
      }

      if (path === '/api/observe-inbox') {
        const severity = parsed.searchParams.get('severity');
        const skill = parsed.searchParams.get('skill');
        const limitRaw = parsed.searchParams.get('limit');
        const limit = limitRaw ? Math.max(1, Number(limitRaw) || 0) : 0;
        let items = queryObservationInbox(observationsDir);
        if (skill) {
          items = items.filter((item) => item.skillName === skill);
        }
        if (severity === 'high' || severity === 'medium' || severity === 'low' || severity === 'noise') {
          items = items.filter((item) => item.severity === severity);
        }
        if (limit > 0) items = items.slice(0, limit);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(items));
        return;
      }

      if (path === '/api/observe-inbox/diagnostics') {
        const idx = buildSkillIndex(analysesDir, doctorsDir, observationsDir, skillIndexOptions());
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          sourceCoverage: idx.diagnosisSummary.sourceCoverage,
          summary: idx.diagnosisSummary,
          bySkill: Object.fromEntries(idx.diagnosticsBySkill),
          active: activeStudioDiagnostics({
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            sourceCoverage: idx.diagnosisSummary.sourceCoverage,
            bySkill: Object.fromEntries(idx.diagnosticsBySkill),
          }),
        }));
        return;
      }

      if (path === '/api/observe-inbox/show') {
        const id = parsed.searchParams.get('id') || '';
        const item = id ? findObservationInboxItem(id, observationsDir) : null;
        res.writeHead(item ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(item ? { id, text: formatObservationShow(item) } : { error: 'observation not found' }));
        return;
      }

      if (path === '/api/observe-inbox/review-state') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(loadObservationReviewState(observationsDir)));
          return;
        }
        if (req.method === 'POST') {
          assertTrustedMutationRequest(req);
          const body = await readJsonObjectBody(req) as Partial<ObservationReviewStateUpdate>;
          const targetType = body.targetType as ObservationReviewStateUpdate['targetType'];
          const targetId = body.targetId as string;
          const verdict = body.verdict as ObservationReviewStateUpdate['verdict'];
          const now = new Date().toISOString();
          const state = updateObservationReviewState(observationsDir, {
            targetType,
            targetId,
            verdict,
            note: body.note,
            reason: body.reason,
            metricKey: body.metricKey as ObservationReviewStateUpdate['metricKey'],
            metricScope: body.metricScope as ObservationReviewStateUpdate['metricScope'],
            metricScopeId: body.metricScopeId,
            traceId: body.traceId,
            sourceTrace: body.sourceTrace,
            sessionId: body.sessionId,
            messageIndex: body.messageIndex,
            messageUuid: body.messageUuid,
            callInstanceId: body.callInstanceId,
            toolUseId: body.toolUseId,
            snippet: body.snippet,
          }, now);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(state));
          return;
        }
        if (req.method === 'DELETE') {
          assertTrustedMutationRequest(req);
          const targetType = parsed.searchParams.get('targetType') as ObservationReviewStateUpdate['targetType'];
          const targetId = parsed.searchParams.get('targetId') ?? '';
          const state = deleteObservationReviewState(observationsDir, targetType, targetId);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(state));
          return;
        }
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }

      const doctorDetailMatch = path.match(/^\/doctors\/(.+)$/);
      if (doctorDetailMatch) {
        const id = decodeURIComponent(doctorDetailMatch[1]);
        const skillName = parsed.searchParams.get('skill') ?? '';
        const report = loadDoctorReport(doctorsDir, id, skillName || undefined, includeDoctorCards);
        if (!report) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(lang === 'en' ? 'doctor report not found' : '体检报告不存在');
          return;
        }
        let ctx: SkillReportContext | undefined;
        if (skillName) {
          const idx = buildSkillIndex(analysesDir, doctorsDir, observationsDir, skillIndexOptions());
          const entry = idx.entries.find((en) => en.skillName === skillName);
          if (entry) ctx = buildSkillContext(entry, id, idx.insightsBySkill.get(entry.skillName) ?? [], lang);
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
        res.end(renderDoctorDetail(report, skillName, langQ, lang, ctx));
        return;
      }

      const analysisDetailMatch = path.match(/^\/observe-health\/(.+)$/);
      if (analysisDetailMatch) {
        const id = decodeURIComponent(analysisDetailMatch[1]);
        const report = loadAnalysis(analysesDir, id, includeObserveCards);
        if (!report) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('analysis not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderSkillHealthReport(report, lang));
        return;
      }

      const analysisApiMatch = path.match(/^\/api\/observe-health\/(.+)$/);
      if (analysisApiMatch) {
        const id = decodeURIComponent(analysisApiMatch[1]);
        const report = loadAnalysis(analysesDir, id, includeObserveCards);
        if (!report) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'analysis not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
        return;
      }

      const skillTrendApiMatch = path.match(/^\/api\/skill-trend\/(.+)$/);
      if (skillTrendApiMatch) {
        const skillName = decodeURIComponent(skillTrendApiMatch[1]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(querySkillTrend(analysesDir, skillName, includeObserveCards)));
        return;
      }

      const skillTrendPageMatch = path.match(/^\/skill-trend\/(.+)$/);
      if (skillTrendPageMatch) {
        const skillName = decodeURIComponent(skillTrendPageMatch[1]);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderSkillTrendPage(querySkillTrend(analysesDir, skillName, includeObserveCards), lang));
        return;
      }

      if (path === '/analyses-diff') {
        const fromId = parsed.searchParams.get('from');
        const toId = parsed.searchParams.get('to');
        if (!fromId || !toId) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('missing from/to query params');
          return;
        }
        const diff = querySkillDiff(analysesDir, fromId, toId, includeObserveCards);
        if (!diff) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('analysis not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderSkillDiffPage(diff, lang));
        return;
      }

      if (path === '/api/analyses-diff') {
        const fromId = parsed.searchParams.get('from');
        const toId = parsed.searchParams.get('to');
        if (!fromId || !toId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing from/to query params' }));
          return;
        }
        const diff = querySkillDiff(analysesDir, fromId, toId, includeObserveCards);
        if (!diff) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'analysis not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(diff));
        return;
      }


      // Studio 先呈现机器上的 Codex 主对话，再从某次对话进入原生 turn 任务轨迹。
      // /conversations 保留为同义入口，避免旧书签失效。
      if (path === '/') {
        const html = renderConversationIndexPage(await resolvedConversationCatalog.listConversations(), lang);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // 原 skill-centric 工作台迁到 /knowledge。insightsBySkill 在 buildSkillIndex 里
      // 跟 SkillIndex 一起算好并享受同一份缓存，renderer 只负责呈现。
      if (path === '/knowledge') {
        const idx = buildSkillIndex(analysesDir, doctorsDir, observationsDir, skillIndexOptions());
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderSkillList(idx, lang));
        return;
      }

      if (path === '/api/skills') {
        const idx = buildSkillIndex(analysesDir, doctorsDir, observationsDir, skillIndexOptions());
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          entries: idx.entries.map((entry) => ({
            ...entry,
            insightCount: idx.insightsBySkill.get(entry.skillName)?.length ?? 0,
            diagnosisCount: idx.diagnosticsBySkill.get(entry.skillName)?.length ?? 0,
          })),
          summary: idx.summary,
          diagnosisSummary: idx.diagnosisSummary,
        }));
        return;
      }

      const skillHubMatch = path.match(/^\/skills\/(.+)$/);
      if (skillHubMatch) {
        let skillName: string;
        try {
          skillName = decodeURIComponent(skillHubMatch[1]);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(lang === 'en' ? 'skill not found' : '未找到该 skill');
          return;
        }
        const idx = buildSkillIndex(analysesDir, doctorsDir, observationsDir, skillIndexOptions());
        const entry = idx.entries.find((en) => en.skillName === skillName);
        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(lang === 'en' ? 'skill not found' : '未找到该 skill');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderSkillDetail(entry, lang, idx.insightsBySkill.get(entry.skillName) ?? []));
        return;
      }

      const skillDiagnosticsApiMatch = path.match(/^\/api\/skills\/(.+)\/diagnostics$/);
      if (skillDiagnosticsApiMatch) {
        const skillName = decodeURIComponent(skillDiagnosticsApiMatch[1]);
        const idx = buildSkillIndex(analysesDir, doctorsDir, observationsDir, skillIndexOptions());
        const diagnostics = idx.diagnosticsBySkill.get(skillName);
        if (!diagnostics) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'skill diagnostics not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          skillName,
          sourceCoverage: idx.diagnosisSummary.sourceCoverage,
          diagnostics,
        }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err: unknown) {
      if (res.headersSent) {
        res.destroy(err instanceof Error ? err : new Error(getErrorMessage(err)));
        return;
      }
      const statusCode = err instanceof RequestBodyError
        ? err.statusCode
        : err instanceof ObservationReviewStateValidationError
          ? 400
          : 500;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: getErrorMessage(err) }));
    }
  }

  async function start(): Promise<string> {
    if (server) return serverUrl!;
    // Studio 只读消费测量产物；只有观察收件箱需要预建本地目录。
    if (!existsSync(observationsDir)) mkdirSync(observationsDir, { recursive: true });

    const p = port ?? Number(process.env.OMK_REPORT_PORT || DEFAULT_PORT);
    // host 默认 127.0.0.1(本机回环,默认安全)。容器/远程场景需对外暴露时:
    //   - createReportServer({host: '0.0.0.0'}) — programmatic
    //   - OMK_REPORT_HOST=0.0.0.0  omk studio  — 环境变量
    //   - omk studio --host 0.0.0.0           — CLI flag
    const host = hostOption || process.env.OMK_REPORT_HOST || '127.0.0.1';

    const boot = (listenPort: number): Promise<Server> => new Promise((resolve, reject) => {
      const srv = createServer(handleRequest);
      srv.once('error', reject);
      srv.listen(listenPort, host, () => resolve(srv));
    });

    try {
      server = await boot(p);
    } catch (err: unknown) {
      const formatted = formatListenError(p, err);
      if (formatted) throw formatted;

      // EADDRINUSE — check if it's an existing omk service we can take over
      const probeHost = host === '0.0.0.0' ? '127.0.0.1' : host;
      const url = `http://${probeHost}:${p}`;
      let isOmk = false;
      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
        const data = await res.json() as { service?: string };
        isOmk = data.service === 'omk';
      } catch { /* not reachable or not omk */ }

      if (isOmk) {
        // Shut down old omk service, then take over the port
        try { await fetch(`${url}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 500));
        try {
          server = await boot(p);
        } catch {
          throw new Error(`port ${p} is still in use; close it manually and retry: lsof -ti:${p} | xargs kill`);
        }
      } else {
        throw new Error(
          `port ${p} is already in use by another process.\n` +
          `  inspect: lsof -i:${p}\n` +
          `  release: lsof -ti:${p} | xargs kill\n` +
          `  or pick another port: ${PORT_HINT}`
        );
      }
    }

    const addr = server!.address() as AddressInfo;
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    serverUrl = `http://${displayHost}:${addr.port}`;
    return serverUrl;
  }

  async function stop(): Promise<void> {
    if (!server) return;
    for (const close of [...liveStreamClosers]) close();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    serverUrl = null;
  }

  function getUrl(): string | null {
    return serverUrl;
  }

  return { start, stop, getUrl };
}
