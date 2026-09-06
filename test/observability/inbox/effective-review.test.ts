import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { buildObservationInboxReport, saveObservationInboxReport } from '../../../src/observability/inbox/index.js';
import { projectEffectiveObservationReview } from '../../../src/observability/inbox/effective-review.js';
import { buildObservationInboxViewModel } from '../../../src/observability/inbox/view-model.js';
import { observationMetricAnnotationTargetId, updateObservationReviewState } from '../../../src/observability/inbox/review-state.js';
import { ZERO_INDICATORS } from '../../../src/observability/experience/report-derivations.js';
import type { ObservationExperienceReport } from '../../../src/observability/experience.js';
import type { ObservationReviewState } from '../../../src/observability/inbox/review-state.js';
import ObserveInbox from '../../../src/cli/commands/observe/inbox.js';
import { runCommand } from '../../helpers/run-command.js';
import { createReportServer } from '../../../src/studio/http/report-server.js';
import { renderObservationInboxPage } from '../../../src/studio/presentation/observation-inbox-renderer.js';

const emptyReviewState: ObservationReviewState = {
  kind: 'observe-review-state', schemaVersion: 2,
  updatedAt: '2026-05-10T00:00:00.000Z', entries: {},
};

describe('effective observation review', () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-effective-review-'));
  let report: ReturnType<typeof buildObservationInboxReport>;
  beforeAll(() => {
    const records = [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 's1', timestamp: '2026-05-01T00:00:00.000Z', cwd: root, message: { role: 'user', content: '<command-name>/audit</command-name>\n请检查这个方案，不要遗漏证据。' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 's1', timestamp: '2026-05-01T00:00:01.000Z', cwd: root, message: { role: 'assistant', content: [{ type: 'text', text: '已完成，结果在 report.md。' }] } },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: 's1', timestamp: '2026-05-01T00:00:02.000Z', cwd: root, message: { role: 'user', content: '不对，请重新检查。' } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u2', sessionId: 's1', timestamp: '2026-05-01T00:00:03.000Z', cwd: root, message: { role: 'assistant', content: [{ type: 'text', text: '已修正，结果在 report.md。' }] } },
    ];
    const path = join(root, 'trace.jsonl');
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n'));
    report = buildObservationInboxReport(path);
    assert.ok(report.experience?.sessions.length);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    [{ userCorrectionCount: 1 }, 'sample_review'],
    [{ toolFailureCount: 3, toolCallCount: 3 }, 'review_first'],
    [{ routerDownstreamFailed: 2 }, 'review_first'],
    [{ explicitMarkerCount: 2 }, 'review_first'],
  ] as const)('uses weighted domain priority for %j', (counts, priority) => {
    const raw = structuredClone(report.experience!);
    const session = raw.sessions[0];
    session.indicators = { ...ZERO_INDICATORS, ...counts };
    session.sessionStory = undefined;
    session.reviewerReport = undefined;
    session.timelinePreview = [];
    session.fullSessionTimeline = [];
    session.attributedEventIds = [];
    const before = JSON.stringify(raw);
    const view = projectEffectiveObservationReview([raw], emptyReviewState);
    assert.equal(view.effectiveExperienceReports[0].sessions[0].reviewPriority, priority);
    assert.equal(view.resolvedReviewSessions[session.id].priority, priority);
    assert.deepEqual(view.effectiveExperienceReports[0].sessions[0].indicators, session.indicators);
    assert.equal(JSON.stringify(raw), before);
  });

  it('applies a rejected canonical signal once and preserves raw evidence', () => {
    const raw = report.experience!;
    const session = raw.sessions[0];
    const event = session.fullSessionTimeline.find((event) => event.messageUuid === 'u2' && event.kind === 'user_message');
    assert.ok(event);
    const state = updateObservationReviewState(join(root, 'canonical'), {
      targetType: 'evidence_metric',
      targetId: observationMetricAnnotationTargetId({ ...event, metricScopeId: session.id }, 'user_correction'),
      metricKey: 'user_correction', metricScopeId: session.id, verdict: 'rejected',
    }, '2026-05-10T00:00:00.000Z');
    const before = JSON.stringify(raw);
    assert.ok(projectEffectiveObservationReview([raw], emptyReviewState).effectiveExperienceReports[0].sessions[0].indicators.userCorrectionCount > 0);
    const first = projectEffectiveObservationReview([raw], state);
    const second = projectEffectiveObservationReview(first.effectiveExperienceReports, state);
    assert.equal(first.effectiveExperienceReports[0].sessions[0].indicators.userCorrectionCount, 0);
    assert.deepEqual(second.effectiveExperienceReports[0].sessions[0].indicators, first.effectiveExperienceReports[0].sessions[0].indicators);
    assert.equal(JSON.stringify(raw), before);
  });

  it('does not turn a truncated preview into zero counts', () => {
    const raw = structuredClone(report.experience!);
    const session = raw.sessions[0];
    session.sessionStory = undefined;
    session.reviewerReport = undefined;
    session.indicators.hardRuleTextHitCount = 4;
    const event = session.timelinePreview.find((event) => event.kind === 'user_message');
    assert.ok(event);
    session.fullSessionTimeline = [];
    session.attributedEventIds = ['missing-event'];
    const state = updateObservationReviewState(join(root, 'partial'), {
      targetType: 'evidence_metric',
      targetId: observationMetricAnnotationTargetId({ ...event, metricScopeId: session.id }, 'hard_rule'),
      metricKey: 'hard_rule', metricScopeId: session.id, verdict: 'rejected',
    }, '2026-05-10T00:00:00.000Z');
    const view = projectEffectiveObservationReview([raw], state);
    assert.equal(view.effectiveExperienceReports[0].sessions[0].indicators.hardRuleTextHitCount, 4);
    assert.ok(view.unappliedMetricAnnotations[session.id].includes('hard_rule'));
  });

  it.each([false, true])('shares the projection across CLI JSON, HTTP and HTML with rejected annotation=%s', async (rejected) => {
    const observationsDir = join(root, `shared-${rejected}`);
    const persisted = saveObservationInboxReport(report, observationsDir);
    const before = readFileSync(persisted, 'utf-8');
    if (rejected) {
      const session = report.experience!.sessions[0];
      const event = session.fullSessionTimeline.find((event) => event.messageUuid === 'u2' && event.kind === 'user_message');
      assert.ok(event);
      updateObservationReviewState(observationsDir, {
        targetType: 'evidence_metric',
        targetId: observationMetricAnnotationTargetId({ ...event, metricScopeId: session.id }, 'user_correction'),
        metricKey: 'user_correction', metricScopeId: session.id, verdict: 'rejected',
      }, '2026-05-10T00:00:00.000Z');
    }
    const expected = buildObservationInboxViewModel(observationsDir, { skill: 'audit' });
    const cli = await runCommand(ObserveInbox, ['--input-dir', observationsDir, '--skill', 'audit', '--json']);
    const json = JSON.parse(cli.stdout) as { effectiveExperienceReports: ObservationExperienceReport[] };
    assert.deepEqual(json.effectiveExperienceReports, JSON.parse(JSON.stringify(expected.effectiveExperienceReports)));
    const server = createReportServer({ port: 0, observationsDir, analysesDir: join(root, 'analyses'), doctorsDir: join(root, 'doctors') });
    try {
      const url = await server.start();
      const api = await fetch(`${url}/api/observe-inbox/view?skill=audit`);
      assert.equal(api.status, 200);
      const apiView = await api.json() as { effectiveExperienceReports: ObservationExperienceReport[] };
      assert.deepEqual(apiView.effectiveExperienceReports, json.effectiveExperienceReports);
      const html = await fetch(`${url}/observe-inbox?skill=audit&lang=zh`);
      assert.equal(await html.text(), renderObservationInboxPage(expected, 'zh'));
    } finally {
      await server.stop();
    }
    assert.equal(readFileSync(persisted, 'utf-8'), before);
  });
});
