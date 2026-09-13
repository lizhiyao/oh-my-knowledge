import { listManagedRows, loadAllManagedRecords, managedDir as projectManagedDir, resolveManagedDir } from '../../../knowledge-artifacts/governance/index.js';
import type { KnowledgeQuery } from '../../application/knowledge-query.js';
import { listAnalyses, loadAnalysis, loadDoctorReport, querySkillDiff, querySkillTrend } from '../../application/knowledge-reports.js';
import { buildSkillContext } from '../../application/skill-health.js';
import { renderDoctorDetail } from '../../presentation/doctor-detail-renderer.js';
import { renderAnalysisList, renderSkillDiffPage, renderSkillTrendPage } from '../../presentation/knowledge-reports-renderer.js';
import { DEFAULT_LANG } from '../../presentation/layout.js';
import { renderManagedHistory, renderManagedList } from '../../presentation/managed-history-renderer.js';
import { renderSkillHealthReport } from '../../presentation/skill-health-renderer.js';
import type { SkillReportContext } from '../../view-models/report-context.js';
import { HTML_HEADERS, JSON_HEADERS, TEXT_HEADERS, writeJsonError } from '../errors.js';
import type { StudioRouteContext } from './contracts.js';
import { createStudioRouter, type StudioRouteDefinition } from './router.js';

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
) => Promise<boolean>;

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

  const routes: StudioRouteDefinition<KnowledgeRouteContext>[] = [
    {
      pattern: '/api/observe-health',
      handler({ response: res, analysesDir }) {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(listAnalyses(analysesDir, includeObserveCards)));
      },
    },
    {
      pattern: '/observe/health',
      handler({ response: res, analysesDir, lang }) {
        res.writeHead(200, HTML_HEADERS);
        res.end(renderAnalysisList(listAnalyses(analysesDir, includeObserveCards), lang));
      },
    },
    {
      // 受管 skill 决策史（#203 管理支柱可视化出口）。只读受管记录,口径同 omk list。
      pattern: '/api/managed',
      handler({ response: res }) {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ schemaVersion: 1, rows: listManagedRows(resolveManagedRoot()) }));
      },
    },
    {
      pattern: '/knowledge/managed',
      handler({ response: res, lang }) {
        res.writeHead(200, HTML_HEADERS);
        res.end(renderManagedList(listManagedRows(resolveManagedRoot()), lang));
      },
    },
    {
      pattern: '/knowledge/managed/*id',
      handler({ response: res, params, lang }) {
        const id = params.id;
        // 按稳定 id(= hash(kind, name)) 精确查 —— 同名不同 kind(skill/review vs prompt/review)各有独立 id,
        // 不会串到同一页;且只在已加载、已校验的记录里查,不拼文件路径、无路径穿越。
        const record = id ? loadAllManagedRecords(resolveManagedRoot()).find((r) => r.id === id) : undefined;
        if (!record) {
          res.writeHead(404, TEXT_HEADERS);
          res.end(lang === 'en' ? 'managed record not found' : '受管记录不存在');
          return;
        }
        res.writeHead(200, HTML_HEADERS);
        res.end(renderManagedHistory(record, lang));
      },
    },
    {
      pattern: '/knowledge/doctors/*id',
      handler({ response: res, url, params, lang, analysesDir, doctorsDir }) {
        const id = params.id;
        const skillName = url.searchParams.get('skill') ?? '';
        const report = loadDoctorReport(doctorsDir, id, skillName || undefined, includeDoctorCards);
        if (!report) {
          res.writeHead(404, TEXT_HEADERS);
          res.end(lang === 'en' ? 'doctor report not found' : '体检报告不存在');
          return;
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
      },
    },
    {
      pattern: '/observe/health/*id',
      handler({ response: res, params, lang, analysesDir }) {
        const report = loadAnalysis(analysesDir, params.id, includeObserveCards);
        if (!report) {
          res.writeHead(404, TEXT_HEADERS);
          res.end('analysis not found');
          return;
        }
        res.writeHead(200, HTML_HEADERS);
        res.end(renderSkillHealthReport(report, lang));
      },
    },
    {
      pattern: '/api/observe-health/*id',
      handler({ response: res, params, analysesDir }) {
        const report = loadAnalysis(analysesDir, params.id, includeObserveCards);
        if (!report) {
          writeJsonError(res, 404, 'analysis_not_found');
          return;
        }
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(report));
      },
    },
    {
      pattern: '/api/skill-trend/*skill',
      handler({ response: res, params, analysesDir }) {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(querySkillTrend(analysesDir, params.skill, includeObserveCards)));
      },
    },
    {
      pattern: '/observe/skill-trend/*skill',
      handler({ response: res, params, lang, analysesDir }) {
        res.writeHead(200, HTML_HEADERS);
        res.end(renderSkillTrendPage(querySkillTrend(analysesDir, params.skill, includeObserveCards), lang));
      },
    },
    {
      pattern: '/observe/health-diff',
      handler({ response: res, url, lang, analysesDir }) {
        const fromId = url.searchParams.get('from');
        const toId = url.searchParams.get('to');
        if (!fromId || !toId) {
          res.writeHead(400, TEXT_HEADERS);
          res.end('missing from/to query params');
          return;
        }
        const diff = querySkillDiff(analysesDir, fromId, toId, includeObserveCards);
        if (!diff) {
          res.writeHead(404, TEXT_HEADERS);
          res.end('analysis not found');
          return;
        }
        res.writeHead(200, HTML_HEADERS);
        res.end(renderSkillDiffPage(diff, lang));
      },
    },
    {
      pattern: '/api/analyses-diff',
      handler({ response: res, url, analysesDir }) {
        const fromId = url.searchParams.get('from');
        const toId = url.searchParams.get('to');
        if (!fromId || !toId) {
          writeJsonError(res, 400, 'missing_query_params');
          return;
        }
        const diff = querySkillDiff(analysesDir, fromId, toId, includeObserveCards);
        if (!diff) {
          writeJsonError(res, 404, 'analysis_not_found');
          return;
        }
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(diff));
      },
    },
    {
      pattern: '/api/skills',
      handler({ response: res, analysesDir, doctorsDir }) {
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
      },
    },
    {
      pattern: '/api/skills/*skill/diagnostics',
      handler({ response: res, params, analysesDir, doctorsDir }) {
        const skillName = params.skill;
        const idx = query.read({ analysesDir, doctorsDir });
        const diagnostics = idx.diagnosticsBySkill.get(skillName);
        if (!diagnostics) {
          writeJsonError(res, 404, 'skill_diagnostics_not_found');
          return;
        }
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({
          skillName,
          sourceCoverage: idx.diagnosisSummary.sourceCoverage,
          diagnostics,
        }));
      },
    },
  ];

  return createStudioRouter(routes);
}
