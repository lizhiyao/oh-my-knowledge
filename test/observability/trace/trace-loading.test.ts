import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTraceSessions, loadTraceCorpus, segmentTraceBySkill, tracesToAnalysisEntries } from '../../../src/observability/trace/index.js';
import { buildObservationExperienceReport, compactObservationExperienceReport, normalizeObservationExperienceReport } from '../../../src/observability/experience.js';
import { jsonl, asstRec, userRec, writeSession, traceFixture } from '../../helpers/trace-fixtures.js';

const fixture = traceFixture();

describe('source discovery and trace loading', () => {
  it('skip malformed lines, does not crash', () => {
    const path = writeSession(fixture.directory, 'broken.jsonl', [{ type: 'permission-mode', sessionId: 's1' }]);
    writeFileSync(path, 'not-json-line\n' + jsonl([{ type: 'permission-mode', sessionId: 's1' }]));
    const sessions = loadTraceSessions(path);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].runId, 's1');
  });

  it('ignores valid JSON primitives and does not synthesize empty sessions', () => {
    const path = join(fixture.directory, 'non-records.jsonl');
    writeFileSync(path, 'null\n\"text\"\n[]\n{broken');
    assert.deepEqual(loadTraceSessions(path), []);
  });

  it('reports malformed, ignored and unrecognized input instead of dropping it silently', () => {
    const path = join(fixture.directory, 'mixed-input.jsonl');
    writeFileSync(path, [
      '{broken',
      'null',
      '[]',
      JSON.stringify({ type: 'future-record', sessionId: 's1' }),
    ].join('\n'));

    const corpus = loadTraceCorpus(path);
    assert.equal(corpus.sessions.length, 1);
    assert.equal(corpus.sessions[0].sourceKind, 'unknown');
    assert.deepEqual(corpus.ingestion, {
      fileCount: 1,
      sourceRecordCount: 4,
      parsedRecordCount: 1,
      malformedRecordCount: 1,
      ignoredValueCount: 2,
      unknownEventCount: 1,
      filteredSessionCount: 0,
    });
    assert.equal(corpus.sessions[0].events[0].sourceIndex, 3);
  });

  it('streams JSONL without corrupting multi-byte UTF-8 across read chunks', () => {
    const text = '你'.repeat(30_000);
    const path = writeSession(fixture.directory, 'chunked-utf8.jsonl', [
      asstRec('utf8-chunked', [{ type: 'text', text }], { sessionId: 'chunked-utf8' }),
    ]);

    const corpus = loadTraceCorpus(path);
    const message = corpus.sessions[0].events.find((event) => event.eventKind === 'message');
    assert.ok(message?.eventKind === 'message');
    assert.ok(message.text.includes(text), '跨读块边界的多字节字符必须整字复原');
  });

  it('rejects an oversized complete JSONL record even when it ends with a newline', () => {
    const path = join(fixture.directory, 'oversized-complete-record.jsonl');
    writeFileSync(path, `${'x'.repeat(32 * 1024 * 1024 + 1)}\n`);
    // 文案不带单位：整档按字符判，≥16 MiB 的 Codex 档走惰性视图同样按字符拒绝。
    assert.throws(
      () => loadTraceSessions(path),
      /trace JSONL 单条记录超过 33554432 上限/,
    );
  });

  it('fails closed when a discovered trace input cannot be read', () => {
    const brokenPath = join(fixture.directory, 'broken.jsonl');
    symlinkSync(join(fixture.directory, 'missing-target.jsonl'), brokenPath);
    assert.throws(
      () => loadTraceCorpus(fixture.directory),
      (error: unknown) =>
        error instanceof Error
        && error.message === `无法读取 trace 输入项：${brokenPath}`,
    );
  });

  it('does not recurse forever or ingest a trace twice through directory symlink cycles', () => {
    const nested = join(fixture.directory, 'nested');
    mkdirSync(nested);
    writeSession(nested, 'one.jsonl', [{ type: 'permission-mode', sessionId: 'one' }]);
    symlinkSync(fixture.directory, join(nested, 'cycle'));

    const corpus = loadTraceCorpus(fixture.directory);
    assert.equal(corpus.sessions.length, 1);
    assert.equal(corpus.sessions[0].runId, 'one');
    assert.equal(corpus.ingestion.fileCount, 1);
  });

  it('does not follow discovered trace symlinks outside the requested root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'omk-trace-outside-'));
    try {
      writeSession(outside, 'outside.jsonl', [{
        type: 'permission-mode',
        sessionId: 'outside',
      }]);
      symlinkSync(outside, join(fixture.directory, 'outside-link'));
      writeSession(fixture.directory, 'inside.jsonl', [{
        type: 'permission-mode',
        sessionId: 'inside',
      }]);

      const corpus = loadTraceCorpus(fixture.directory);
      assert.deepEqual(corpus.sessions.map((session) => session.runId), ['inside']);
      assert.equal(corpus.ingestion.fileCount, 1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('fails closed when one JSONL file ambiguously matches multiple source adapters', () => {
    const path = writeSession(fixture.directory, 'ambiguous-source.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-part' },
      },
      userRec('claude-part', '继续检查。', { sessionId: 'claude-part' }),
    ]);

    const corpus = loadTraceCorpus(path);
    assert.equal(corpus.sessions.length, 1);
    assert.equal(corpus.sessions[0].sourceKind, 'unknown');
    assert.equal(corpus.sessions[0].events.length, 2);
    assert.equal(
      corpus.sessions[0].events.every((event) => event.eventKind === 'unknown'),
      true,
    );
    assert.equal(corpus.ingestion.unknownEventCount, 2);
  });

  it('uses patch_apply_end as the authoritative apply_patch result', () => {
    const path = writeSession(fixture.directory, 'codex-patch-outcome.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-patch-outcome' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'patch-1',
          name: 'apply_patch',
          input: '*** Begin Patch',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'patch_apply_end',
          call_id: 'patch-1',
          success: false,
          status: 'failed',
          stderr: 'patch failed',
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'patch-1',
          output: 'Success. Updated the following files:',
        },
      },
    ]);

    const corpus = loadTraceCorpus(path);
    const result = corpus.sessions[0].events.find((event) => event.eventKind === 'tool_result');
    assert.equal(result?.eventKind, 'tool_result');
    if (result?.eventKind !== 'tool_result') assert.fail('expected tool result');
    assert.equal(result.status, 'failure');
    assert.equal(result.statusSource, 'runtime');
    assert.equal(corpus.ingestion.unknownEventCount, 0);
  });

  it('recovers a complete apply_patch pair from a truncated patch_apply_end', () => {
    const path = writeSession(fixture.directory, 'codex-truncated-patch.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-truncated-patch' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'patch_apply_end',
          call_id: 'patch-1',
          success: true,
          status: 'completed',
          stdout: 'Success. Updated the following files:',
        },
      },
    ]);

    const corpus = loadTraceCorpus(path);
    const events = corpus.sessions[0].events;
    assert.equal(events.filter((event) => event.eventKind === 'tool_call').length, 1);
    const result = events.find((event) => event.eventKind === 'tool_result');
    assert.equal(result?.eventKind, 'tool_result');
    if (result?.eventKind !== 'tool_result') assert.fail('expected tool result');
    assert.equal(result.status, 'success');
    assert.equal(result.statusSource, 'runtime');
    assert.equal(corpus.ingestion.unknownEventCount, 0);
  });

  it('loads multiple JSONL from directory', () => {
    writeSession(fixture.directory, 'a.jsonl', [{ type: 'permission-mode', sessionId: 'sa' }]);
    writeSession(fixture.directory, 'b.jsonl', [{ type: 'permission-mode', sessionId: 'sb' }]);
    const sessions = loadTraceSessions(fixture.directory);
    assert.equal(sessions.length, 2);
    const ids = sessions.map((s) => s.runId).sort();
    assert.deepEqual(ids, ['sa', 'sb']);
  });

  it('groups subagents JSONL under the parent session folder', () => {
    const sessionDir = join(fixture.directory, 'sessionA');
    const subagentsDir = join(sessionDir, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    writeSession(sessionDir, 'main.jsonl', [
      userRec('u-main', '<command-name>/main-skill</command-name>', { sessionId: 'sessionA', timestamp: '2026-05-01T00:00:00.000Z' }),
      asstRec('a-main', [{ type: 'tool_use', id: 'task1', name: 'Task', input: { prompt: 'delegate' } }], { sessionId: 'sessionA', timestamp: '2026-05-01T00:00:01.000Z' }),
    ]);
    writeSession(subagentsDir, 'x1.jsonl', [
      userRec('u-x1', '<command-name>/child-skill</command-name>', { sessionId: 'child-1', timestamp: '2026-05-01T00:00:02.000Z' }),
      asstRec('a-x1', [{ type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: '/tmp/a.md' } }], { sessionId: 'child-1', timestamp: '2026-05-01T00:00:03.000Z' }),
    ]);

    const sessions = loadTraceSessions(sessionDir).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
    assert.equal(sessions.length, 2);
    assert.deepEqual(new Set(sessions.map((session) => session.rootRunId)), new Set(['sessionA']));
    assert.deepEqual(sessions.map((session) => session.role).sort(), ['main', 'subagent']);

    const { segments } = tracesToAnalysisEntries(sessionDir);
    const child = segments.find((segment) => segment.skillName === 'child-skill');
    assert.ok(child);
    assert.equal(child.sessionId, 'sessionA');
    assert.equal(child.traceSessionId, 'child-1');
    assert.equal(child.traceRole, 'subagent');
    assert.ok(child.sourceTrace?.endsWith('subagents/x1.jsonl'));

    const experience = buildObservationExperienceReport({
      sessions,
      segments: sessions.flatMap((session) => segmentTraceBySkill(session)),
      items: [],
      generatedAt: '2026-05-01T00:00:04.000Z',
    });
    const reversedExperience = buildObservationExperienceReport({
      sessions: [...sessions].reverse(),
      segments: [...sessions].reverse().flatMap((session) => segmentTraceBySkill(session)),
      items: [],
      generatedAt: '2026-05-01T00:00:04.000Z',
    });
    assert.deepEqual(
      reversedExperience.storyContexts,
      experience.storyContexts,
      'canonical session stories must not depend on skill traversal order',
    );
    assert.equal(experience.storyContexts[0].goalSlices.length, 2);
    assert.ok(experience.sessions.every((session) =>
      session.sessionStory?.goalSliceCount === experience.storyContexts[0].goalSlices.length
    ));
    const compact = compactObservationExperienceReport(experience);
    const branch = compact.traceTimelines[0].tree.branches[0];
    assert.ok(branch);
    const wrongBranchTrace = structuredClone(compact);
    wrongBranchTrace.traceTimelines[0].tree.branches[0].sourceTrace = '/wrong/trace.jsonl';
    assert.equal(normalizeObservationExperienceReport(wrongBranchTrace), null);
    const danglingBranchAttachment = structuredClone(compact);
    danglingBranchAttachment.traceTimelines[0].tree.branches[0].attachTo = {
      sourceTrace: compact.traceTimelines[0].tree.main[0].sourceTrace,
      toolUseId: 'missing-tool-use',
    };
    assert.equal(normalizeObservationExperienceReport(danglingBranchAttachment), null);
    const mismatchedDispatch = structuredClone(compact);
    mismatchedDispatch.storyContexts[0].subagentDispatches[0].eventCount += 1;
    assert.equal(normalizeObservationExperienceReport(mismatchedDispatch), null);

    const duplicateTimelineStore = structuredClone(compact);
    const alternateTimelineId = `${duplicateTimelineStore.traceTimelines[0].id}:duplicate`;
    duplicateTimelineStore.traceTimelines.push({
      ...structuredClone(duplicateTimelineStore.traceTimelines[0]),
      id: alternateTimelineId,
    });
    const alternateTimelineSession = duplicateTimelineStore.sessions[1];
    assert.ok(alternateTimelineSession);
    alternateTimelineSession.timelineRef = alternateTimelineId;
    for (const invocationId of alternateTimelineSession.invocationIds) {
      const invocation = duplicateTimelineStore.invocations.find(
        (candidate) => candidate.id === invocationId,
      );
      assert.ok(invocation);
      invocation.timelineRef = alternateTimelineId;
    }
    assert.equal(normalizeObservationExperienceReport(duplicateTimelineStore), null);

    const duplicateStoryStore = structuredClone(compact);
    const alternateStoryId = `${duplicateStoryStore.storyContexts[0].id}:duplicate`;
    duplicateStoryStore.storyContexts.push({
      ...structuredClone(duplicateStoryStore.storyContexts[0]),
      id: alternateStoryId,
    });
    const alternateStorySession = duplicateStoryStore.sessions[1];
    assert.ok(alternateStorySession?.sessionStory);
    alternateStorySession.sessionStory.contextRef = alternateStoryId;
    assert.equal(normalizeObservationExperienceReport(duplicateStoryStore), null);
  });

  it('maps the AI-SDK sibling host reasoning block beside the tool block of the same record', () => {
    const path = writeSession(fixture.directory, 'claude-family-reasoning.jsonl', [
      asstRec('a1', [
        { type: 'reasoning', text: '用户想知道当前仓库列表。' },
        { type: 'tool-call', toolCallId: 'fc-ls', toolName: 'Bash', input: { command: 'ls' } },
      ]),
    ]);

    const [session] = loadTraceSessions(path);
    const activity = session.events.find((event) => event.eventKind === 'model_activity');
    assert.ok(activity?.eventKind === 'model_activity');
    assert.equal(activity.contentVisibility, 'plaintext');
    assert.equal(activity.text, '用户想知道当前仓库列表。');
    const call = session.events.find((event) => event.eventKind === 'tool_call');
    assert.ok(call?.eventKind === 'tool_call');
    assert.equal(call.callId, 'fc-ls');
    assert.equal(session.events.filter((event) => event.eventKind === 'unknown').length, 0);
  });

  it('isolates parent links when a source reuses the referenced run id', () => {
    for (const name of ['first', 'second']) {
      writeSession(fixture.directory, `rollout-duplicate-parent-${name}.jsonl`, [{
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'duplicate-parent',
          cwd: `/repo-${name}`,
          originator: 'Codex Desktop',
          model_provider: 'openai',
        },
      }]);
    }
    writeSession(fixture.directory, 'rollout-ambiguous-child.jsonl', [{
      timestamp: '2026-07-25T00:00:01.000Z',
      type: 'session_meta',
      payload: {
        id: 'ambiguous-child',
        parent_thread_id: 'duplicate-parent',
        cwd: '/repo-child',
        originator: 'Codex Desktop',
        thread_source: 'subagent',
        model_provider: 'openai',
      },
    }]);

    const sessions = loadTraceSessions(fixture.directory);
    assert.equal(sessions.length, 3);
    assert.equal(new Set(sessions.map((session) => session.groupPath)).size, 3);
    assert.equal(
      sessions.find((session) => session.runId === 'ambiguous-child')?.rootRunId,
      'ambiguous-child',
    );
  });

  it('isolates cyclic parent links instead of inventing a logical root', () => {
    writeSession(fixture.directory, 'rollout-cycle-a.jsonl', [{
      timestamp: '2026-07-25T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'cycle-a',
        parent_thread_id: 'cycle-b',
        cwd: '/repo',
        originator: 'Codex Desktop',
        thread_source: 'subagent',
        model_provider: 'openai',
      },
    }]);
    writeSession(fixture.directory, 'rollout-cycle-b.jsonl', [{
      timestamp: '2026-07-25T00:00:01.000Z',
      type: 'session_meta',
      payload: {
        id: 'cycle-b',
        parent_thread_id: 'cycle-a',
        cwd: '/repo',
        originator: 'Codex Desktop',
        thread_source: 'subagent',
        model_provider: 'openai',
      },
    }]);

    const sessions = loadTraceSessions(fixture.directory).sort((a, b) => a.runId.localeCompare(b.runId));
    assert.deepEqual(sessions.map((session) => session.rootRunId), ['cycle-a', 'cycle-b']);
    assert.equal(new Set(sessions.map((session) => session.groupPath)).size, 2);
  });
});
