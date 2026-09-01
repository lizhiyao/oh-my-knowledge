import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { buildObservationInboxReport } from '../../src/observability/inbox.js';
import {
  buildKnowledgeDebuggerViewModel,
  projectKnowledgeEvidence,
} from '../../src/observability/knowledge-debugger.js';
import { reconstructExperienceTurns } from '../../src/observability/turn-index.js';
import type { ExperienceTimelineEvent } from '../../src/observability/contracts/experience.js';

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

describe('Knowledge Debugger task trajectory', () => {
  it('reconstructs a failed Codex task into paired, readable steps', () => {
    const fixturePath = new URL('../fixtures/codex-knowledge-debugger-failure.jsonl', import.meta.url);
    assert.ok(readFileSync(fixturePath, 'utf-8').includes('missing doctor/eval evidence'));
    const report = buildObservationInboxReport(fixturePath.pathname);
    const session = report.experience?.sessions[0];
    assert.ok(session);

    const model = buildKnowledgeDebuggerViewModel(session, 'turn-release', report.meta.ingestion);
    assert.equal(model.summary.userGoal, '检查并发布当前版本。');
    assert.equal(model.summary.finalResponse, '版本已经可以发布。');
    assert.equal(model.summary.observedStartTimestamp, '2026-08-03T00:00:00.500Z');
    assert.equal(model.summary.observedEndTimestamp, '2026-08-03T00:00:07.000Z');
    assert.equal(model.summary.toolCallCount, 2);
    assert.equal(model.summary.toolFailureCount, 1);
    assert.equal(model.summary.hasUserCorrection, true);
    assert.equal(model.integrity.status, 'complete');

    const modelActivitySteps = model.steps.filter((step) => step.stepKind === 'model_activity');
    assert.equal(modelActivitySteps.length, 2);
    assert.equal(modelActivitySteps[0]?.events[0]?.contentVisibility, 'plaintext');
    assert.equal(modelActivitySteps[0]?.events[0]?.fullText, '检查发布证据');
    assert.equal(modelActivitySteps[1]?.events[0]?.contentVisibility, 'opaque');
    assert.equal(modelActivitySteps[1]?.events[0]?.fullText, undefined);

    const toolSteps = model.steps.filter((step) => step.stepKind === 'tool_exchange');
    assert.equal(toolSteps.length, 2);
    assert.ok(toolSteps.every((step) => step.events.length === 2));
    assert.equal(toolSteps[1].toolStatus, 'failure');
    assert.match(toolSteps[1].events[1]?.fullText ?? '', /missing doctor\/eval evidence/);
    assert.equal(model.steps.at(-2)?.stepKind, 'lifecycle');
    assert.equal(model.steps.at(-1)?.stepKind, 'user_correction');
    assert.ok(model.normalizedEvents.every((item) => item.turnId !== 'turn-correction'));
    assert.equal(model.taskScope.basis, 'turn_id');
    assert.equal(model.taskScope.turnId, 'turn-release');

    const agents = model.knowledgeEvidence.find((item) => item.knowledgeKind === 'project_instruction');
    const release = model.knowledgeEvidence.find((item) => item.knowledgeKind === 'skill');
    assert.equal(agents?.accessKind, 'injected');
    assert.equal(release?.label, 'release');
    assert.equal(release?.accessKind, 'read');
    assert.ok(model.steps.some((step) => step.knowledgeEvidenceIds.includes(release?.id ?? '')));
  });

  it('preserves explicitly recorded models for task-level and event-level presentation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-debugger-model-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      { timestamp: '2026-08-03T00:00:00.000Z', type: 'session_meta', payload: { id: 'modeled-task', session_id: 'modeled-task', cwd: '/repo', originator: 'Codex Desktop', model_provider: 'openai' } },
      { timestamp: '2026-08-03T00:00:00.100Z', type: 'turn_context', payload: { turn_id: 'turn-1', cwd: '/repo', model: 'gpt-5.4' } },
      { timestamp: '2026-08-03T00:00:01.000Z', type: 'response_item', payload: { type: 'message', id: 'user-1', role: 'user', content: [{ type: 'input_text', text: '检查当前任务。' }] } },
      { timestamp: '2026-08-03T00:00:02.000Z', type: 'event_msg', payload: { type: 'agent_reasoning', text: '检查任务状态' } },
      { timestamp: '2026-08-03T00:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'read-skill', name: 'exec_command', input: JSON.stringify({ cmd: "sed -n '1,120p' .agents/skills/check/SKILL.md" }) } },
      { timestamp: '2026-08-03T00:00:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'read-skill', output: '# Check\nInspect the current task.' } },
      { timestamp: '2026-08-03T00:00:05.000Z', type: 'response_item', payload: { type: 'message', id: 'assistant-1', role: 'assistant', content: [{ type: 'output_text', text: '检查完成。' }] } },
    ];
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n'));

    const report = buildObservationInboxReport(file);
    const session = report.experience?.sessions[0];
    assert.ok(session);
    const model = buildKnowledgeDebuggerViewModel(session, 'turn-1', report.meta.ingestion);

    assert.deepEqual(model.summary.observedModels, ['gpt-5.4']);
    const modeledEvents = model.steps
      .filter((step) => step.stepKind === 'assistant_message' || step.stepKind === 'model_activity')
      .flatMap((step) => step.events);
    assert.ok(modeledEvents.length >= 2);
    assert.ok(modeledEvents.every((item) => item.model === 'gpt-5.4'));
  });

  it('keeps the task trajectory inside the attributed task window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-debugger-task-window-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      { timestamp: '2026-08-03T00:00:00.000Z', type: 'session_meta', payload: { id: 'task-window', session_id: 'task-window', cwd: '/repo', originator: 'Codex Desktop' } },
      { timestamp: '2026-08-03T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-old' } },
      { timestamp: '2026-08-03T00:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '这是同一 session 中更早的另一个任务。' }] } },
      { timestamp: '2026-08-03T00:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '更早任务已完成。' }] } },
      { timestamp: '2026-08-03T00:00:04.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
      { timestamp: '2026-08-03T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-current' } },
      { timestamp: '2026-08-03T00:00:06.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '检查并发布当前版本。' }] } },
      { timestamp: '2026-08-03T00:00:07.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'read-skill', name: 'exec_command', input: JSON.stringify({ cmd: "sed -n '1,120p' .agents/skills/release/SKILL.md" }) } },
      { timestamp: '2026-08-03T00:00:08.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'read-skill', output: '# Release\nCheck evidence.' } },
      { timestamp: '2026-08-03T00:00:09.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '当前版本已检查。' }] } },
      { timestamp: '2026-08-03T00:00:10.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
    ];
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n'));
    const report = buildObservationInboxReport(file);
    const session = report.experience?.sessions[0];
    assert.ok(session);
    const model = buildKnowledgeDebuggerViewModel(session, 'turn-current');

    assert.equal(model.summary.userGoal, '检查并发布当前版本。');
    assert.equal(model.summary.finalResponse, '当前版本已检查。');
    assert.equal(model.taskScope.basis, 'turn_id');
    assert.equal(model.taskScope.turnId, 'turn-current');
    assert.ok(model.normalizedEvents.every((item) => item.turnId !== 'turn-old'));
    assert.ok(model.normalizedEvents.some((item) => item.label === 'turn_started'));
    assert.ok(model.normalizedEvents.some((item) => item.label === 'turn_completed'));
    assert.equal(model.integrity.status, 'complete');
  });

  it('keeps lifecycle events out of Knowledge and projects the current turn completion as a lifecycle step', () => {
    const report = buildObservationInboxReport(
      new URL('../fixtures/codex-knowledge-debugger-failure.jsonl', import.meta.url).pathname,
    );
    const session = report.experience?.sessions[0];
    assert.ok(session);
    const model = buildKnowledgeDebuggerViewModel(session, 'turn-release');

    const completion = model.steps.find((step) => step.events[0]?.label === 'turn_completed');
    assert.equal(completion?.stepKind, 'lifecycle');
    assert.ok(model.knowledgeEvidence.every((item) =>
      item.evidenceRefs.every((ref) => ref.kind !== 'lifecycle')
    ));
  });

  it('does not carry the previous Codex turn completion into the attributed task', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-debugger-turn-boundary-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      { timestamp: '2026-08-03T00:00:00.000Z', type: 'session_meta', payload: { id: 'turn-boundary', session_id: 'turn-boundary', cwd: '/repo', originator: 'Codex Desktop', model_provider: 'openai' } },
      { timestamp: '2026-08-03T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
      { timestamp: '2026-08-03T00:00:01.500Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-current' } },
      { timestamp: '2026-08-03T00:00:02.000Z', type: 'response_item', payload: { type: 'message', id: 'user-current', role: 'user', content: [{ type: 'input_text', text: '完成本次发布。' }] } },
      { timestamp: '2026-08-03T00:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'read-skill', name: 'exec_command', input: JSON.stringify({ cmd: "sed -n '1,120p' .agents/skills/release/SKILL.md" }) } },
      { timestamp: '2026-08-03T00:00:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'read-skill', output: '# Release\nCheck evidence.' } },
      { timestamp: '2026-08-03T00:00:05.000Z', type: 'response_item', payload: { type: 'message', id: 'assistant-current', role: 'assistant', content: [{ type: 'output_text', text: '本次发布已完成。' }] } },
      { timestamp: '2026-08-03T00:00:06.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
    ];
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n'));

    const report = buildObservationInboxReport(file);
    const session = report.experience?.sessions[0];
    assert.ok(session);
    const lifecycleEvents = session.timelinePreview.filter((item) => item.kind === 'lifecycle');
    assert.deepEqual(lifecycleEvents.map((item) => item.timestamp), ['2026-08-03T00:00:06.000Z']);
    assert.equal(session.timelinePreview.some((item) =>
      item.kind === 'runtime_context' && item.label === 'turn_completed'
    ), false);

    const model = buildKnowledgeDebuggerViewModel(session, 'turn-current', report.meta.ingestion);
    assert.equal(model.summary.userGoal, '完成本次发布。');
    assert.equal(model.steps.at(-1)?.stepKind, 'lifecycle');
    assert.equal(model.steps.at(-1)?.events[0]?.timestamp, '2026-08-03T00:00:06.000Z');
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

    const terminal = session.fullSessionTimeline.find((item) => item.label === 'turn_completed');
    assert.ok(terminal);
    const filler = Array.from({ length: 245 }, (_, index) => event(`filler-${index + 1}`, 'model_activity', {
      order: terminal.order - 300 + index,
      turnId: 'turn-release',
      traceId: terminal.traceId,
      sourceTrace: terminal.sourceTrace,
      sessionId: terminal.sessionId,
      timestamp: `2026-08-03T00:00:07.${String(index + 1).padStart(3, '0')}Z`,
      modelActivityKind: 'reasoning',
      contentVisibility: 'opaque',
      label: 'model reasoning',
    }));
    const withoutResult = session.fullSessionTimeline.filter((item) => item.id !== publishResult.id);
    const terminalIndex = withoutResult.findIndex((item) => item.id === terminal.id);
    const expandedTimeline = [
      ...withoutResult.slice(0, terminalIndex),
      ...filler,
      ...withoutResult.slice(terminalIndex),
    ];

    const model = buildKnowledgeDebuggerViewModel({
      ...session,
      fullSessionTimeline: expandedTimeline,
      turns: reconstructExperienceTurns(expandedTimeline),
      attributedEventIds: [
        ...session.attributedEventIds.filter((id) => id !== publishResult.id),
        ...filler.map((item) => item.id),
      ],
    }, 'turn-release', {
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

  it('computes task facts from the complete window instead of the bounded replay', () => {
    const events = [
      event('task-start', 'lifecycle', {
        order: 0, turnId: 'turn-long', label: 'turn_started', timestamp: '2026-08-03T00:00:00.000Z',
      }),
      event('user', 'user_message', {
        order: 1, turnId: 'turn-long', role: 'user', fullText: '检查长任务。', timestamp: '2026-08-03T00:00:01.000Z',
      }),
      ...Array.from({ length: 245 }, (_, index) => event(`context-${index}`, 'runtime_context', {
        order: index + 2,
        turnId: 'turn-long',
        runtimeKind: 'execution_context',
        timestamp: `2026-08-03T00:00:02.${String(index).padStart(3, '0')}Z`,
      })),
      event('unmatched-call', 'tool_use', {
        order: 247,
        turnId: 'turn-long',
        callInstanceId: 'missing-result',
        toolName: 'Bash',
        timestamp: '2026-08-03T00:00:03.000Z',
      }),
      event('assistant', 'assistant_message', {
        order: 248, turnId: 'turn-long', role: 'assistant', fullText: '检查结束。', timestamp: '2026-08-03T00:00:04.000Z',
      }),
      event('task-end', 'lifecycle', {
        order: 249, turnId: 'turn-long', label: 'turn_completed', timestamp: '2026-08-03T00:00:05.000Z',
      }),
    ];
    const turns = reconstructExperienceTurns(events);
    const model = buildKnowledgeDebuggerViewModel({
      id: 'session-1',
      threadId: 'thread-long',
      sourceThreadId: 'session-1',
      sessionId: 'session-1',
      sourceTrace: '/traces/codex.jsonl',
      sourceKind: 'codex',
      turns,
      attributedEventIds: [],
      fullSessionTimeline: events,
    }, 'turn-long');

    assert.equal(model.taskScope.truncated, true);
    assert.equal(model.steps.some((step) => step.events[0]?.id === 'unmatched-call'), false);
    assert.equal(model.summary.toolCallCount, 1);
    assert.ok(model.integrity.notices.some((notice) => (
      notice.code === 'unmatched_tool_calls' && notice.count === 1
    )));
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
      event('e5', 'tool_use', {
        callInstanceId: 'call-publish',
        toolName: 'Bash',
        fullText: JSON.stringify({ cmd: 'npm publish' }),
      }),
      event('e6', 'tool_result', {
        callInstanceId: 'call-publish',
        fullText: 'Process exited with code 1',
        isError: true,
      }),
    ]);

    assert.equal(projected.length, 1);
    assert.equal(projected[0].knowledgeKind, 'runtime_evidence');
    assert.equal(projected[0].sourceLocator, '/repo/src/auth.ts');
  });
});
