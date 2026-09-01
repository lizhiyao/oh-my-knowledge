import { activeStudioDiagnostics } from '../../../diagnosis/studio-projection.js';
import {
  findObservationInboxItem,
  formatObservationShow,
  queryObservationInbox,
} from '../../../observability/inbox.js';
import { buildObservationInboxViewModel } from '../../../observability/inbox-view-model.js';
import { buildKnowledgeDebuggerViewModel } from '../../../observability/knowledge-debugger.js';
import {
  deleteObservationReviewState,
  loadObservationReviewState,
  updateObservationReviewState,
  type ObservationReviewStateUpdate,
} from '../../../observability/review-state.js';
import {
  loadObservationSourceRecordArchive,
  summarizeObservationSourceRecordArchive,
} from '../../../observability/source-record-archive.js';
import { buildSkillIndex } from '../../application/index.js';
import { renderKnowledgeDebuggerPage } from '../../presentation/knowledge-debugger-renderer.js';
import { DEFAULT_LANG } from '../../presentation/layout.js';
import { renderObservationInboxPage } from '../../presentation/observation-inbox-renderer.js';
import {
  assertTrustedMutationRequest,
  readJsonObjectBody,
} from '../request-errors.js';
import type { StudioRouteContext } from './contracts.js';

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
) => boolean | Promise<boolean>;

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
  return async ({
    request,
    response,
    url,
    path,
    lang,
    analysesDir,
    doctorsDir,
  }): Promise<boolean> => {
    const legacyRedirect = ((): { to: string; status: 302 | 307 } | undefined => {
      if (path === '/observations' || path === '/observations/inbox') {
        return { to: '/observe-inbox', status: 302 };
      }
      if (path === '/api/observations/inbox') return { to: '/api/observe-inbox', status: 307 };
      if (path === '/api/observations/show') return { to: '/api/observe-inbox/show', status: 307 };
      if (path === '/api/observations/diagnostics') return { to: '/api/observe-inbox/diagnostics', status: 307 };
      if (path === '/api/observations/review-state') return { to: '/api/observe-inbox/review-state', status: 307 };
      return undefined;
    })();
    if (legacyRedirect) {
      response.writeHead(legacyRedirect.status, { Location: legacyRedirect.to + url.search });
      response.end();
      return true;
    }

    if (path === '/observe-inbox') {
      const skill = url.searchParams.get('skill') || undefined;
      const html = renderObservationInboxPage(
        buildObservationInboxViewModel(observationsDir, { skill }),
        lang,
      );
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
      return true;
    }

    const knowledgeDebuggerMatch = path.match(/^\/observe-debugger\/(.+)$/);
    if (knowledgeDebuggerMatch) {
      let experienceSessionId = '';
      try { experienceSessionId = decodeURIComponent(knowledgeDebuggerMatch[1]); } catch { /* invalid path */ }
      const context = experienceSessionId
        ? findKnowledgeDebuggerContext(observationsDir, experienceSessionId)
        : undefined;
      if (!context) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(lang === 'en' ? 'experience session not found' : '观测会话不存在');
        return true;
      }
      const targetTurnId = url.searchParams.get('turnId')?.trim();
      if (!targetTurnId) {
        const langQuery = lang === DEFAULT_LANG ? '' : '?lang=en';
        response.writeHead(302, {
          Location: `/conversations/${encodeURIComponent(context.session.threadId)}${langQuery}`,
        });
        response.end();
        return true;
      }
      if (!context.session.turns.some((turn) => turn.turnId === targetTurnId)) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(lang === 'en' ? 'task turn not found' : '任务不存在');
        return true;
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
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
      return true;
    }

    const knowledgeDebuggerSourceMatch = path.match(/^\/api\/observe-debugger\/(.+)\/source-records$/);
    if (knowledgeDebuggerSourceMatch) {
      let experienceSessionId = '';
      try { experienceSessionId = decodeURIComponent(knowledgeDebuggerSourceMatch[1]); } catch { /* invalid path */ }
      const context = experienceSessionId
        ? findKnowledgeDebuggerContext(observationsDir, experienceSessionId)
        : undefined;
      if (!context) {
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'experience_session_not_found' }));
        return true;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(
        loadObservationSourceRecordArchive(context.sourceRecordRef, observationsDir),
      ));
      return true;
    }

    if (path === '/api/observe-inbox') {
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
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(items));
      return true;
    }

    if (path === '/api/observe-inbox/diagnostics') {
      const index = buildSkillIndex(
        analysesDir,
        doctorsDir,
        observationsDir,
        { includeObserveCards, includeDoctorCards },
      );
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
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
      return true;
    }

    if (path === '/api/observe-inbox/show') {
      const id = url.searchParams.get('id') || '';
      const item = id ? findObservationInboxItem(id, observationsDir) : null;
      response.writeHead(item ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(
        item ? { id, text: formatObservationShow(item) } : { error: 'observation not found' },
      ));
      return true;
    }

    if (path === '/api/observe-inbox/review-state') {
      if (request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(loadObservationReviewState(observationsDir)));
        return true;
      }
      if (request.method === 'POST') {
        assertTrustedMutationRequest(request);
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
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(state));
        return true;
      }
      if (request.method === 'DELETE') {
        assertTrustedMutationRequest(request);
        const targetType = url.searchParams.get('targetType') as ObservationReviewStateUpdate['targetType'];
        const targetId = url.searchParams.get('targetId') ?? '';
        const state = deleteObservationReviewState(observationsDir, targetType, targetId);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(state));
        return true;
      }
      response.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'method not allowed' }));
      return true;
    }

    return false;
  };
}
