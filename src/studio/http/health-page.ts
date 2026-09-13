import { listAnalyses, loadAnalysis, querySkillDiff, querySkillTrend } from '../application/knowledge-reports.js';
import {
  projectDiff,
  projectIndexRows,
  projectReport,
  projectTrend,
  type HealthDiffFacts,
  type HealthIndexRow,
  type HealthReportFacts,
  type HealthTrendFacts,
} from '../application/health-format.js';

/**
 * 页面模型只带投影后的事实：口径（色带阈值、样本守护、差值方向、折线几何）在
 * application/health-format.ts 一处算完，React 树只做呈现。
 */
export type HealthPage =
  | { pageKind: 'index'; rows: HealthIndexRow[] }
  | { pageKind: 'report'; report: HealthReportFacts }
  | { pageKind: 'trend'; trend: HealthTrendFacts }
  | { pageKind: 'diff'; diff: HealthDiffFacts };

/**
 * 页面装载结果。状态码语义与既有一致：缺 from/to 是请求错（400），
 * 报告／身份查不到是缺页（404），数据源读取抛错由宿主兜成 503。
 */
export type HealthPageLoad =
  | { status: 'ok'; page: HealthPage }
  | { status: 'missing_query_params' }
  | { status: 'analysis_not_found' };

export interface HealthPageSource {
  readonly analysesDir: string;
  readonly includeObserveCards: boolean;
}

const INDEX_PATH = '/observe/health';
const DIFF_PATH = '/observe/health-diff';
const REPORT_PREFIX = '/observe/health/';
const TREND_PREFIX = '/observe/skill-trend/';

/** 观测健康页面组是否属于本宿主；裁掉页面组的宿主不接管这些路径。 */
export function isHealthPath(path: string): boolean {
  return path === INDEX_PATH || path === DIFF_PATH || path.startsWith(REPORT_PREFIX) || path.startsWith(TREND_PREFIX);
}

/**
 * 报告 id 与 skill 名都是单段身份（存储记录的 basename），畸形或越段身份一律当作缺页，
 * 不拿它去拼目录，也不渲染成「该对象暂无数据」。
 */
function singleSegment(encoded: string): string | undefined {
  if (!encoded || encoded.includes('/')) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

export function loadHealthPage(source: HealthPageSource, path: string, searchParams: URLSearchParams): HealthPageLoad {
  const { analysesDir, includeObserveCards } = source;
  if (path === DIFF_PATH) {
    const fromId = searchParams.get('from');
    const toId = searchParams.get('to');
    if (!fromId || !toId) return { status: 'missing_query_params' };
    const diff = querySkillDiff(analysesDir, fromId, toId, includeObserveCards);
    return diff ? { status: 'ok', page: { pageKind: 'diff', diff: { ...diff, rows: projectDiff(diff.rows) } } } : { status: 'analysis_not_found' };
  }
  if (path.startsWith(REPORT_PREFIX)) {
    const analysisId = singleSegment(path.slice(REPORT_PREFIX.length));
    const report = analysisId === undefined ? null : loadAnalysis(analysesDir, analysisId, includeObserveCards);
    if (analysisId === undefined || report === null) return { status: 'analysis_not_found' };
    return { status: 'ok', page: { pageKind: 'report', report: projectReport(analysisId, report) } };
  }
  if (path.startsWith(TREND_PREFIX)) {
    const skillName = singleSegment(path.slice(TREND_PREFIX.length));
    if (skillName === undefined) return { status: 'analysis_not_found' };
    return { status: 'ok', page: { pageKind: 'trend', trend: projectTrend(querySkillTrend(analysesDir, skillName, includeObserveCards)) } };
  }
  return {
    status: 'ok',
    page: { pageKind: 'index', rows: projectIndexRows(listAnalyses(analysesDir, includeObserveCards)) },
  };
}
