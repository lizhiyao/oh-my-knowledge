import type { KnowledgeQuery } from '../../application/knowledge/knowledge-query.js';
import { listAnalyses } from '../../application/knowledge/knowledge-reports.js';
import { JSON_HEADERS } from '../errors.js';
import type { StudioRouteContext } from './contracts.js';
import { createStudioRouter, type StudioRouteDefinition } from './router.js';

interface KnowledgeRoutesOptions {
  readonly query: KnowledgeQuery;
  readonly includeObserveCards: boolean;
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
  includeObserveCards,
}: KnowledgeRoutesOptions): KnowledgeRouteHandler {

  const routes: StudioRouteDefinition<KnowledgeRouteContext>[] = [
    {
      pattern: '/api/observe-health',
      handler({ response: res, analysesDir }) {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(listAnalyses(analysesDir, includeObserveCards)));
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
