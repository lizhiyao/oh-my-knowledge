import { listManagedRows, loadAllManagedRecords, managedDir as projectManagedDir, resolveManagedDir } from '../../../knowledge-artifacts/governance/index.js';
import type { KnowledgeQuery } from '../../application/knowledge-query.js';
import { listAnalyses, loadAnalysis, loadDoctorReport, querySkillDiff, querySkillTrend } from '../../application/knowledge-reports.js';
import { buildSkillContext } from '../../application/skill-health.js';
import { renderDoctorDetail } from '../../presentation/doctor-detail-renderer.js';
import { renderAnalysisList, renderSkillDiffPage, renderSkillTrendPage } from '../../presentation/knowledge-reports-renderer.js';
import { DEFAULT_LANG } from '../../presentation/layout.js';
import { renderManagedHistory, renderManagedList } from '../../presentation/managed-history-renderer.js';
import { renderSkillDetail } from '../../presentation/skill-detail-renderer.js';
import { renderSkillHealthReport } from '../../presentation/skill-health-renderer.js';
import { renderSkillList } from '../../presentation/skill-list-renderer.js';
import type { SkillReportContext } from '../../view-models/report-context.js';
import { loadChartJsBundle } from '../chart-asset.js';
import { HTML_HEADERS, JSON_HEADERS, TEXT_HEADERS, writeJsonError } from '../errors.js';
import type { StudioRouteContext } from './contracts.js';

interface KnowledgeRoutesOptions {
  readonly query: KnowledgeQuery;
  readonly includeObserveCards: boolean;
  readonly includeDoctorCards: boolean;
  readonly managedDir: string | (() => string) | undefined;
}

export interface KnowledgeRouteContext extends StudioRouteContext {
  readonly analysesDir: string;
  readonly doctorsDir: string;
}

export type KnowledgeRouteHandler = (
  context: KnowledgeRouteContext,
) => boolean;

export function createKnowledgeRoutes({
  query,
  managedDir,
  includeObserveCards,
  includeDoctorCards,
}: KnowledgeRoutesOptions): KnowledgeRouteHandler {
  // 受管根目录按**请求**解析,不在启动时冻结 —— 否则长会话里会跟 omk list 分叉：Studio 启动时项目 .omk/governance/managed
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

  return ({
    response: res,
    url: parsed,
    path,
    lang,
    analysesDir,
    doctorsDir,
  }): boolean => {
      // 静态资源:chart.js UMD bundle(供详情页趋势大图使用)。
      // 用 require.resolve 拿包路径,避开 dist 相对路径脆弱性。
      if (path === '/static/chart.js') {
        const bytes = loadChartJsBundle();
        if (!bytes) {
          res.writeHead(500, TEXT_HEADERS);
          res.end('chart_asset_unavailable');
          return true;
        }
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
        res.end(bytes);
        return true;
      }

      // 本轮仅调整页面路径，已有 API 契约保持不变。
      const legacyObserveRedirect = ((): { to: string; status: 307 } | null => {
        if (path === '/api/analyses') return { to: '/api/observe-health', status: 307 };
        const apiDetail = path.match(/^\/api\/analyses\/(.+)$/);
        if (apiDetail) return { to: `/api/observe-health/${apiDetail[1]}`, status: 307 };
        return null;
      })();
      if (legacyObserveRedirect) {
        res.writeHead(legacyObserveRedirect.status, { Location: legacyObserveRedirect.to + parsed.search });
        res.end();
        return true;
      }

      if (path === '/api/observe-health') {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(listAnalyses(analysesDir, includeObserveCards)));
        return true;
      }

      if (path === '/observe/health') {
        res.writeHead(200, HTML_HEADERS);
        res.end(renderAnalysisList(listAnalyses(analysesDir, includeObserveCards), lang));
        return true;
      }

      // 受管 skill 决策史（#203 管理支柱可视化出口）。只读受管记录,口径同 omk list。
      if (path === '/api/managed') {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ schemaVersion: 1, rows: listManagedRows(resolveManagedRoot()) }));
        return true;
      }

      if (path === '/knowledge/managed') {
        res.writeHead(200, HTML_HEADERS);
        res.end(renderManagedList(listManagedRows(resolveManagedRoot()), lang));
        return true;
      }

      const managedDetailMatch = path.match(/^\/knowledge\/managed\/(.+)$/);
      if (managedDetailMatch) {
        let id: string;
        try { id = decodeURIComponent(managedDetailMatch[1]); } catch { id = ''; }
        // 按稳定 id(= hash(kind, name)) 精确查 —— 同名不同 kind(skill/review vs prompt/review)各有独立 id,
        // 不会串到同一页;且只在已加载、已校验的记录里查,不拼文件路径、无路径穿越。
        const record = id ? loadAllManagedRecords(resolveManagedRoot()).find((r) => r.id === id) : undefined;
        if (!record) {
          res.writeHead(404, TEXT_HEADERS);
          res.end(lang === 'en' ? 'managed record not found' : '受管记录不存在');
          return true;
        }
        res.writeHead(200, HTML_HEADERS);
        res.end(renderManagedHistory(record, lang));
        return true;
      }

      const doctorDetailMatch = path.match(/^\/knowledge\/doctors\/(.+)$/);
      if (doctorDetailMatch) {
        const id = decodeURIComponent(doctorDetailMatch[1]);
        const skillName = parsed.searchParams.get('skill') ?? '';
        const report = loadDoctorReport(doctorsDir, id, skillName || undefined, includeDoctorCards);
        if (!report) {
          res.writeHead(404, TEXT_HEADERS);
          res.end(lang === 'en' ? 'doctor report not found' : '体检报告不存在');
          return true;
        }
        let ctx: SkillReportContext | undefined;
        if (skillName) {
          const idx = query.read({ analysesDir, doctorsDir });
          const entry = idx.entries.find((en) => en.skillName === skillName);
          if (entry) ctx = buildSkillContext(entry, id, idx.insightsBySkill.get(entry.skillName) ?? [], lang);
        }
        res.writeHead(200, HTML_HEADERS);
        const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
        res.end(renderDoctorDetail(report, skillName, langQ, lang, ctx));
        return true;
      }

      const analysisDetailMatch = path.match(/^\/observe\/health\/(.+)$/);
      if (analysisDetailMatch) {
        const id = decodeURIComponent(analysisDetailMatch[1]);
        const report = loadAnalysis(analysesDir, id, includeObserveCards);
        if (!report) {
          res.writeHead(404, TEXT_HEADERS);
          res.end('analysis not found');
          return true;
        }
        res.writeHead(200, HTML_HEADERS);
        res.end(renderSkillHealthReport(report, lang));
        return true;
      }

      const analysisApiMatch = path.match(/^\/api\/observe-health\/(.+)$/);
      if (analysisApiMatch) {
        const id = decodeURIComponent(analysisApiMatch[1]);
        const report = loadAnalysis(analysesDir, id, includeObserveCards);
        if (!report) {
          writeJsonError(res, 404, 'analysis_not_found');
          return true;
        }
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(report));
        return true;
      }

      const skillTrendApiMatch = path.match(/^\/api\/skill-trend\/(.+)$/);
      if (skillTrendApiMatch) {
        const skillName = decodeURIComponent(skillTrendApiMatch[1]);
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(querySkillTrend(analysesDir, skillName, includeObserveCards)));
        return true;
      }

      const skillTrendPageMatch = path.match(/^\/observe\/skill-trend\/(.+)$/);
      if (skillTrendPageMatch) {
        const skillName = decodeURIComponent(skillTrendPageMatch[1]);
        res.writeHead(200, HTML_HEADERS);
        res.end(renderSkillTrendPage(querySkillTrend(analysesDir, skillName, includeObserveCards), lang));
        return true;
      }

      if (path === '/observe/health-diff') {
        const fromId = parsed.searchParams.get('from');
        const toId = parsed.searchParams.get('to');
        if (!fromId || !toId) {
          res.writeHead(400, TEXT_HEADERS);
          res.end('missing from/to query params');
          return true;
        }
        const diff = querySkillDiff(analysesDir, fromId, toId, includeObserveCards);
        if (!diff) {
          res.writeHead(404, TEXT_HEADERS);
          res.end('analysis not found');
          return true;
        }
        res.writeHead(200, HTML_HEADERS);
        res.end(renderSkillDiffPage(diff, lang));
        return true;
      }

      if (path === '/api/analyses-diff') {
        const fromId = parsed.searchParams.get('from');
        const toId = parsed.searchParams.get('to');
        if (!fromId || !toId) {
          writeJsonError(res, 400, 'missing_query_params');
          return true;
        }
        const diff = querySkillDiff(analysesDir, fromId, toId, includeObserveCards);
        if (!diff) {
          writeJsonError(res, 404, 'analysis_not_found');
          return true;
        }
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(diff));
        return true;
      }

      // 原 skill-centric 工作台迁到 /knowledge。insightsBySkill 在 buildSkillIndex 里
      // 跟 SkillIndex 一起算好并享受同一份缓存，renderer 只负责呈现。
      if (path === '/knowledge') {
        const idx = query.read({ analysesDir, doctorsDir });
        res.writeHead(200, HTML_HEADERS);
        res.end(renderSkillList(idx, lang));
        return true;
      }

      if (path === '/api/skills') {
        const idx = query.read({ analysesDir, doctorsDir });
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({
          entries: idx.entries.map((entry) => ({
            ...entry,
            insightCount: idx.insightsBySkill.get(entry.skillName)?.length ?? 0,
            diagnosisCount: idx.diagnosticsBySkill.get(entry.skillName)?.length ?? 0,
          })),
          summary: idx.summary,
          diagnosisSummary: idx.diagnosisSummary,
        }));
        return true;
      }

      const skillHubMatch = path.match(/^\/knowledge\/skills\/(.+)$/);
      if (skillHubMatch) {
        let skillName: string;
        try {
          skillName = decodeURIComponent(skillHubMatch[1]);
        } catch {
          res.writeHead(404, TEXT_HEADERS);
          res.end(lang === 'en' ? 'skill not found' : '未找到该 skill');
          return true;
        }
        const idx = query.read({ analysesDir, doctorsDir });
        const entry = idx.entries.find((en) => en.skillName === skillName);
        if (!entry) {
          res.writeHead(404, TEXT_HEADERS);
          res.end(lang === 'en' ? 'skill not found' : '未找到该 skill');
          return true;
        }
        res.writeHead(200, HTML_HEADERS);
        res.end(renderSkillDetail(entry, lang, idx.insightsBySkill.get(entry.skillName) ?? []));
        return true;
      }

      const skillDiagnosticsApiMatch = path.match(/^\/api\/skills\/(.+)\/diagnostics$/);
      if (skillDiagnosticsApiMatch) {
        const skillName = decodeURIComponent(skillDiagnosticsApiMatch[1]);
        const idx = query.read({ analysesDir, doctorsDir });
        const diagnostics = idx.diagnosticsBySkill.get(skillName);
        if (!diagnostics) {
          writeJsonError(res, 404, 'skill_diagnostics_not_found');
          return true;
        }
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({
          skillName,
          sourceCoverage: idx.diagnosisSummary.sourceCoverage,
          diagnostics,
        }));
        return true;
      }

      return false;
  };
}
