import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { buildObservationInboxReport } from '../../src/observability/inbox.js';
import {
  buildKnowledgeDebuggerViewModel,
  projectKnowledgeEvidence,
} from '../../src/observability/knowledge-debugger.js';
import type { ExperienceTimelineEvent } from '../../src/types/index.js';

function event(
  id: string,
  kind: ExperienceTimelineEvent['kind'],
  overrides: Partial<ExperienceTimelineEvent> = {},
): ExperienceTimelineEvent {
  return {
    id,
    kind,
    order: Number(id.replace(/\D/g, '')) || 0,
    sourceTrace: '/traces/codex.jsonl',
    sessionId: 'session-1',
    ...overrides,
  };
}

describe('Knowledge Debugger task replay', () => {
  it('reconstructs a failed Codex task into paired, readable steps', () => {
    const fixturePath = new URL('../fixtures/codex-knowledge-debugger-failure.jsonl', import.meta.url);
    assert.ok(readFileSync(fixturePath, 'utf-8').includes('missing doctor/eval evidence'));
    const report = buildObservationInboxReport(fixturePath.pathname);
    const session = report.experience?.sessions[0];
    assert.ok(session);

    const model = buildKnowledgeDebuggerViewModel(session, report.meta.ingestion);
    assert.equal(model.summary.userGoal, '检查并发布当前版本。');
    assert.equal(model.summary.finalResponse, '版本已经可以发布。');
    assert.equal(model.summary.observedStartTimestamp, '2026-08-03T00:00:00.500Z');
    assert.equal(model.summary.observedEndTimestamp, '2026-08-03T00:00:07.000Z');
    assert.equal(model.summary.toolCallCount, 2);
    assert.equal(model.summary.toolFailureCount, 1);
    assert.equal(model.summary.hasUserCorrection, true);
    assert.equal(model.integrity.status, 'complete');

    const toolSteps = model.steps.filter((step) => step.stepKind === 'tool_exchange');
    assert.equal(toolSteps.length, 2);
    assert.ok(toolSteps.every((step) => step.events.length === 2));
    assert.equal(toolSteps[1].toolStatus, 'failure');
    assert.match(toolSteps[1].events[1]?.fullText ?? '', /missing doctor\/eval evidence/);
    assert.equal(model.steps.at(-1)?.stepKind, 'user_correction');

    const agents = model.knowledgeEvidence.find((item) => item.knowledgeKind === 'project_instruction');
    const release = model.knowledgeEvidence.find((item) => item.knowledgeKind === 'skill');
    assert.equal(agents?.accessKind, 'injected');
    assert.equal(release?.label, 'release');
    assert.equal(release?.accessKind, 'read');
    assert.ok(model.steps.some((step) => step.knowledgeEvidenceIds.includes(release?.id ?? '')));
  });

  it('reports truncation, ingestion damage, and unpaired tool calls without inventing results', () => {
    const report = buildObservationInboxReport(
      new URL('../fixtures/codex-knowledge-debugger-failure.jsonl', import.meta.url).pathname,
    );
    const session = report.experience?.sessions[0];
    assert.ok(session);
    const ingestion = report.meta.ingestion;
    assert.ok(ingestion);
    const publishResult = session.fullSessionTimeline.find((item) =>
      item.kind === 'tool_result' && (item.fullText ?? '').includes('missing doctor/eval evidence')
    );
    assert.ok(publishResult);

    const model = buildKnowledgeDebuggerViewModel({
      ...session,
      fullSessionTimeline: session.fullSessionTimeline.filter((item) => item.id !== publishResult.id),
      timelineScope: { ...session.timelineScope, truncated: true },
    }, {
      ...ingestion,
      malformedRecordCount: 2,
      unknownEventCount: 1,
    });

    assert.equal(model.integrity.status, 'partial');
    assert.deepEqual(model.integrity.notices.map((notice) => notice.code), [
      'timeline_truncated',
      'malformed_records',
      'unknown_events',
      'unmatched_tool_calls',
    ]);
    const publish = model.steps.find((step) => (step.events[0]?.fullText ?? '').includes('npm publish'));
    assert.equal(publish?.events.length, 1);
    assert.equal(publish?.toolStatus, 'unknown');
  });
});

describe('Knowledge evidence projection', () => {
  it('projects every injected AGENTS section with separate provenance', () => {
    const projected = projectKnowledgeEvidence([
      event('e1', 'runtime_context', {
        fullText: '<environment_context>repo</environment_context>\n'
          + '# AGENTS.md instructions for /repo\n<INSTRUCTIONS>root</INSTRUCTIONS>\n'
          + '# AGENTS.md instructions for /repo/packages/app\n<INSTRUCTIONS>app</INSTRUCTIONS>',
      }),
    ]);

    assert.equal(projected.length, 2);
    assert.deepEqual(projected.map((item) => item.sourceLocator), [
      'runtime-context:/repo',
      'runtime-context:/repo/packages/app',
    ]);
    assert.notEqual(projected[0].contentHash, projected[1].contentHash);
    assert.ok(projected.every((item) => item.contentHash?.length === 64));
  });

  it('correlates a SKILL.md read with its returned content', () => {
    const [knowledge] = projectKnowledgeEvidence([
      event('e1', 'tool_use', {
        callInstanceId: 'call-1',
        toolName: 'exec_command',
        fullText: JSON.stringify({ command: "sed -n '1,220p' /repo/.agents/skills/review/SKILL.md" }),
      }),
      event('e2', 'tool_result', {
        callInstanceId: 'call-1',
        timestamp: '2026-08-03T00:00:02.000Z',
        fullText: '# Review\nCheck behavior before editing.',
      }),
    ]);

    assert.equal(knowledge.knowledgeKind, 'skill');
    assert.equal(knowledge.accessKind, 'read');
    assert.equal(knowledge.label, 'review');
    assert.equal(knowledge.sourceLocator, '/repo/.agents/skills/review/SKILL.md');
    assert.equal(knowledge.evidenceRefs[0].id, 'e2');
  });

  it('keeps returned runtime evidence but excludes mutation outputs', () => {
    const projected = projectKnowledgeEvidence([
      event('e1', 'tool_use', {
        callInstanceId: 'call-read',
        toolName: 'Read',
        fullText: JSON.stringify({ file_path: '/repo/src/auth.ts' }),
      }),
      event('e2', 'tool_result', {
        callInstanceId: 'call-read',
        fullText: 'export function login() {}',
      }),
      event('e3', 'tool_use', {
        callInstanceId: 'call-write',
        toolName: 'apply_patch',
        fullText: JSON.stringify({ patch: '*** Begin Patch' }),
      }),
      event('e4', 'tool_result', {
        callInstanceId: 'call-write',
        fullText: 'Done!',
      }),
    ]);

    assert.equal(projected.length, 1);
    assert.equal(projected[0].knowledgeKind, 'runtime_evidence');
    assert.equal(projected[0].sourceLocator, '/repo/src/auth.ts');
  });
});
