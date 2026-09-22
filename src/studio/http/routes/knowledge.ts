import { listManagedRows } from '../../../knowledge-artifacts/governance/index.js';
import type { KnowledgeQuery } from '../../application/knowledge/knowledge-query.js';
import { listAnalyses } from '../../application/knowledge/knowledge-reports.js';
import { JSON_HEADERS } from '../errors.js';
import { resolveManagedRootOption } from '../managed-root.js';
import type { StudioRouteContext } from './contracts.js';
import { createStudioRouter, type StudioRouteDefinition } from './router.js';

interface KnowledgeRoutesOptions {
  readonly query: KnowledgeQuery;
  readonly includeObserveCards: boolean;
  readonly managedDir: string | (() => string) | undefined;
}

interface KnowledgeRouteContext extends StudioRouteContext {
  readonly analysesDir: string;
  readonly doctorsDir: string;
}

type KnowledgeRouteHandler = (
  context: KnowledgeRouteContext,
) => Promise<boolean>;

export function createKnowledgeRoutes({
  query,
  managedDir,
  includeObserveCards,
}: KnowledgeRoutesOptions): KnowledgeRouteHandler {
  // 受管根目录按**请求**解析，与 Next 页面宿主同源（口径与注释见 ../managed-root.ts）。
  const resolveManagedRoot = resolveManagedRootOption(managedDir);

  const routes: StudioRouteDefinition<KnowledgeRouteContext>[] = [
    {
      pattern: '/api/observe-health',
      handler({ response: res, analysesDir }) {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(listAnalyses(analysesDir, includeObserveCards)));
      },
    },
    {
      // 受管 skill 决策史（#203 管理支柱可视化出口）。只读受管记录,口径同 omk list。
      // 页面渲染已迁 Next 宿主（/knowledge/managed），这里只留机读投影。
      pattern: '/api/managed',
      handler({ response: res }) {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ schemaVersion: 1, rows: listManagedRows(resolveManagedRoot()) }));
      },
    },
    {
      pattern: '/api/skills',
      handler({ response: res, analysesDir, doctorsDir, lang }) {
        const idx = query.read({ lang }, { analysesDir, doctorsDir });
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
  ];

  return createStudioRouter(routes);
}
