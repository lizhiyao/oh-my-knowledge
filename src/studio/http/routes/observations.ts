import { activeStudioDiagnostics } from '../../../diagnosis/studio-projection.js';
import {
  findObservationInboxItem,
  formatObservationShow,
  queryObservationInbox,
} from '../../../observability/inbox/index.js';
import { buildObservationInboxViewModel } from '../../../observability/inbox/view-model.js';
import { buildKnowledgeDebuggerViewModel } from '../../../observability/conversation/knowledge-debugger.js';
import {
  deleteObservationReviewState,
  loadObservationReviewState,
  updateObservationReviewState,
  type ObservationReviewStateUpdate,
} from '../../../observability/inbox/review-state.js';
import {
  loadObservationSourceRecordArchive,
  summarizeObservationSourceRecordArchive,
} from '../../../observability/inbox/source-record-archive.js';
import { buildSkillIndex } from '../../application/index.js';
import { renderKnowledgeDebuggerPage } from '../../presentation/knowledge-debugger-renderer.js';
import { DEFAULT_LANG } from '../../presentation/layout.js';
import { renderObservationInboxPage } from '../../presentation/observation-inbox-renderer.js';
import { readJsonObjectBody } from '../request-errors.js';
import { HTML_HEADERS, JSON_HEADERS, TEXT_HEADERS, writeJsonError } from '../errors.js';
import type { StudioRouteContext } from './contracts.js';
import { createStudioRouter, type StudioRouteDefinition } from './router.js';

interface ObservationRoutesOptions {
  readonly observationsDir: string;
  readonly includeObserveCards: boolean;
  readonly includeDoctorCards: boolean;
}

export interface ObservationRouteContext extends StudioRouteContext {
  readonly analysesDir: string;
  readonly doctorsDir: string;
}

export type ObservationRouteHandler = (
  context: ObservationRouteContext,
) => Promise<boolean>;

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

export function createObservationRoutes({
  observationsDir,
  includeObserveCards,
  includeDoctorCards,
}: ObservationRoutesOptions): ObservationRouteHandler {
  const routes: StudioRouteDefinition<ObservationRouteContext>[] = [
    {
      pattern: '/observe/inbox',
      handler({ response, url, lang }) {
        const skill = url.searchParams.get('skill') || undefined;
        const html = renderObservationInboxPage(
          buildObservationInboxViewModel(observationsDir, { skill }),
          lang,
        );
        response.writeHead(200, HTML_HEADERS);
        response.end(html);
      },
    },
    {
      pattern: '/observe/sessions/*id',
      handler({ response, url, params, lang }) {
        const experienceSessionId = params.id;
        const context = experienceSessionId
          ? findKnowledgeDebuggerContext(observationsDir, experienceSessionId)
          : undefined;
        if (!context) {
          response.writeHead(404, TEXT_HEADERS);
          response.end(lang === 'en' ? 'experience session not found' : '观测会话不存在');
          return;
        }
        const targetTurnId = url.searchParams.get('turnId')?.trim();
        if (!targetTurnId) {
          const langQuery = lang === DEFAULT_LANG ? '' : '?lang=en';
          response.writeHead(302, {
            Location: `/observe/conversations/${encodeURIComponent(context.session.threadId)}${langQuery}`,
          });
          response.end();
          return;
        }
        if (!context.session.turns.some((turn) => turn.turnId === targetTurnId)) {
          response.writeHead(404, TEXT_HEADERS);
          response.end(lang === 'en' ? 'task turn not found' : '任务不存在');
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
        response.writeHead(200, HTML_HEADERS);
        response.end(html);
      },
    },
    {
      pattern: '/api/observe-debugger/*id/source-records',
      handler({ response, params }) {
        const experienceSessionId = params.id;
        const context = experienceSessionId
          ? findKnowledgeDebuggerContext(observationsDir, experienceSessionId)
          : undefined;
        if (!context) {
          writeJsonError(response, 404, 'experience_session_not_found');
          return;
        }
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(
          loadObservationSourceRecordArchive(context.sourceRecordRef, observationsDir),
        ));
      },
    },
    {
      pattern: '/api/observe-inbox/view',
      handler({ response, url }) {
        const { effectiveExperienceReports, resolvedReviewSessions, unappliedMetricAnnotations } = buildObservationInboxViewModel(observationsDir, { skill: url.searchParams.get('skill') || undefined });
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify({ effectiveExperienceReports, resolvedReviewSessions, unappliedMetricAnnotations }));
      },
    },
    {
      pattern: '/api/observe-inbox',
      handler({ response, url }) {
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
      handler({ response, analysesDir, doctorsDir }) {
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
      handler({ response, url }) {
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
      handler({ response }) {
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(loadObservationReviewState(observationsDir)));
      },
    },
    {
      pattern: '/api/observe-inbox/review-state',
      method: 'POST',
      mutation: true,
      async handler({ request, response }) {
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
      handler({ response, url }) {
        const targetType = url.searchParams.get('targetType') as ObservationReviewStateUpdate['targetType'];
        const targetId = url.searchParams.get('targetId') ?? '';
        const state = deleteObservationReviewState(observationsDir, targetType, targetId);
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(state));
      },
    },
  ];

  return createStudioRouter(routes);
}
