import { activeStudioDiagnostics } from '../../../diagnosis/studio-projection.js';
import {
  findObservationInboxItem,
  formatObservationShow,
  queryObservationInbox,
} from '../../../observability/inbox/index.js';
import { buildObservationInboxViewModel } from '../../../observability/inbox/view-model.js';
import {
  deleteObservationReviewState,
  loadObservationReviewState,
  updateObservationReviewState,
  type ObservationReviewStateUpdate,
} from '../../../observability/inbox/review-state.js';
import { buildSkillIndex } from '../../application/index.js';
import { readJsonObjectBody } from '../request-errors.js';
import { JSON_HEADERS, writeJsonError } from '../errors.js';
import type { StudioRouteContext } from './contracts.js';
import { createStudioRouter, type StudioRouteDefinition } from './router.js';

interface ObservationRoutesOptions {
  readonly observationsDir: string;
  readonly includeObserveCards: boolean;
  readonly includeDoctorCards: boolean;
  /** 是否注册观测收件箱路由组；独立宿主无收件箱入口，传 false 裁剪（#839 批次 0）。 */
  readonly includeInbox: boolean;
}

export interface ObservationRouteContext extends StudioRouteContext {
  readonly analysesDir: string;
  readonly doctorsDir: string;
}

export type ObservationRouteHandler = (
  context: ObservationRouteContext,
) => Promise<boolean>;

export function createObservationRoutes({
  observationsDir,
  includeObserveCards,
  includeDoctorCards,
  includeInbox,
}: ObservationRoutesOptions): ObservationRouteHandler {
  const routes: StudioRouteDefinition<ObservationRouteContext>[] = [
    ...(includeInbox ? [{
      pattern: '/api/observe-inbox/view',
      handler({ response, url }: ObservationRouteContext) {
        const { effectiveExperienceReports, resolvedReviewSessions, unappliedMetricAnnotations } = buildObservationInboxViewModel(observationsDir, { skill: url.searchParams.get('skill') || undefined });
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify({ effectiveExperienceReports, resolvedReviewSessions, unappliedMetricAnnotations }));
      },
    },
    {
      pattern: '/api/observe-inbox',
      handler({ response, url }: ObservationRouteContext) {
        const severity = url.searchParams.get('severity');
        const skill = url.searchParams.get('skill');
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw ? Math.max(1, Number(limitRaw) || 0) : 0;
        let items = queryObservationInbox(observationsDir);
        if (skill) items = items.filter((item) => item.skillName === skill);
        if (severity === 'high' || severity === 'medium' || severity === 'low' || severity === 'noise') {
          items = items.filter((item) => item.severity === severity);
        }
        if (limit > 0) items = items.slice(0, limit);
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(items));
      },
    },
    {
      pattern: '/api/observe-inbox/diagnostics',
      handler({ response, analysesDir, doctorsDir }: ObservationRouteContext) {
        const index = buildSkillIndex(
          analysesDir,
          doctorsDir,
          observationsDir,
          { includeObserveCards, includeDoctorCards },
        );
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify({
          sourceCoverage: index.diagnosisSummary.sourceCoverage,
          summary: index.diagnosisSummary,
          bySkill: Object.fromEntries(index.diagnosticsBySkill),
          active: activeStudioDiagnostics({
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            sourceCoverage: index.diagnosisSummary.sourceCoverage,
            bySkill: Object.fromEntries(index.diagnosticsBySkill),
          }),
        }));
      },
    },
    {
      pattern: '/api/observe-inbox/show',
      handler({ response, url }: ObservationRouteContext) {
        const id = url.searchParams.get('id') || '';
        const item = id ? findObservationInboxItem(id, observationsDir) : null;
        if (!item) {
          writeJsonError(response, 404, 'observation_not_found');
          return;
        }
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify({ id, text: formatObservationShow(item) }));
      },
    },
    {
      pattern: '/api/observe-inbox/review-state',
      handler({ response }: ObservationRouteContext) {
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(loadObservationReviewState(observationsDir)));
      },
    },
    {
      pattern: '/api/observe-inbox/review-state',
      method: 'POST',
      mutation: true,
      async handler({ request, response }: ObservationRouteContext) {
        const body = await readJsonObjectBody(request) as Partial<ObservationReviewStateUpdate>;
        const state = updateObservationReviewState(observationsDir, {
          targetType: body.targetType as ObservationReviewStateUpdate['targetType'],
          targetId: body.targetId as string,
          verdict: body.verdict as ObservationReviewStateUpdate['verdict'],
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
        }, new Date().toISOString());
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(state));
      },
    },
    {
      pattern: '/api/observe-inbox/review-state',
      method: 'DELETE',
      mutation: true,
      handler({ response, url }: ObservationRouteContext) {
        const targetType = url.searchParams.get('targetType') as ObservationReviewStateUpdate['targetType'];
        const targetId = url.searchParams.get('targetId') ?? '';
        const state = deleteObservationReviewState(observationsDir, targetType, targetId);
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(state));
      },
    }] as const : []),
  ];

  return createStudioRouter(routes);
}
