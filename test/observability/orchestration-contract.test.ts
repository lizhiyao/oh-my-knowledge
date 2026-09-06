import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  loadTraceSessions,
  segmentBySkill,
} from '../../src/observability/trace/index.js';
import {
  buildObservationExperienceReport,
  compactObservationExperienceReport,
  normalizeObservationExperienceReport,
} from '../../src/observability/experience.js';

type ChildTerminal = 'completed' | 'aborted';

function writeJsonl(path: string, records: unknown[]): void {
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n'));
}

function writeCodexFixture(root: string, terminal: ChildTerminal): void {
  writeJsonl(join(root, 'parent.jsonl'), [
    {
      timestamp: '2026-07-28T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'contract-parent',
        cwd: '/repo',
        originator: 'Codex Desktop',
        model_provider: 'openai',
      },
    },
    {
      timestamp: '2026-07-28T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: '<command-name>/router-skill</command-name>\nReview the release.',
      },
    },
    {
      timestamp: '2026-07-28T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'read-router',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'cat .agents/skills/router-skill/SKILL.md' }),
      },
    },
    {
      timestamp: '2026-07-28T00:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'read-router',
        output: '# Router Skill',
      },
    },
  ]);
  writeJsonl(join(root, 'child.jsonl'), [
    {
      timestamp: '2026-07-28T00:00:04.000Z',
      type: 'session_meta',
      payload: {
        id: 'contract-child',
        parent_thread_id: 'contract-parent',
        thread_source: 'subagent',
        source: { subagent: 'review' },
        cwd: '/repo',
        originator: 'Codex Desktop',
        model_provider: 'openai',
      },
    },
    {
      timestamp: '2026-07-28T00:00:05.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: '<command-name>/executor-skill</command-name>\nRun the parser check.',
      },
    },
    {
      timestamp: '2026-07-28T00:00:06.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'read-executor',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'cat .agents/skills/executor-skill/SKILL.md' }),
      },
    },
    {
      timestamp: '2026-07-28T00:00:07.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'read-executor',
        output: '# Executor Skill',
      },
    },
    {
      timestamp: '2026-07-28T00:00:08.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'run-check',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'node --test parser.test.js' }),
      },
    },
    {
      timestamp: '2026-07-28T00:00:09.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'run-check',
        output: 'Process exited with code 0\nparser tests passed',
      },
    },
    {
      timestamp: '2026-07-28T00:00:10.000Z',
      type: 'event_msg',
      payload: terminal === 'completed'
        ? { type: 'task_complete', turn_id: 'child-turn' }
        : { type: 'turn_aborted', turn_id: 'child-turn', reason: 'interrupted' },
    },
  ]);
}

function writeCodexStandaloneFixture(root: string): void {
  writeJsonl(join(root, 'standalone.jsonl'), [
    {
      timestamp: '2026-07-28T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'contract-standalone',
        cwd: '/repo',
        originator: 'Codex Desktop',
        model_provider: 'openai',
      },
    },
    {
      timestamp: '2026-07-28T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: '<command-name>/research-skill</command-name>\nInspect the release metadata.',
      },
    },
    {
      timestamp: '2026-07-28T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'inspect-version',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'rg version package.json' }),
      },
    },
    {
      timestamp: '2026-07-28T00:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'inspect-version',
        output: 'Process exited with code 0\n"version": "0.50.0"',
      },
    },
    {
      timestamp: '2026-07-28T00:00:04.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: '<command-name>/release-skill</command-name>\nPublish the release.',
      },
    },
    {
      timestamp: '2026-07-28T00:00:05.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'publish-pr',
        name: 'exec_command',
        arguments: JSON.stringify({
          cmd: 'gh pr create --body "Document the subagent behavior."',
        }),
      },
    },
    {
      timestamp: '2026-07-28T00:00:06.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'publish-pr',
        output: 'Process exited with code 0\nPull request created\n{"session_id":"inspected-session"}',
      },
    },
    {
      timestamp: '2026-07-28T00:00:07.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: '已确认 Guardian subagent 的 parent_thread_id；保留快照供后续分析。',
      },
    },
    {
      timestamp: '2026-07-28T00:00:08.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'standalone-turn' },
    },
  ]);
}

function writeClaudeFixture(root: string, terminal: ChildTerminal): void {
  const sessionDir = join(root, 'contract-parent');
  const childDir = join(sessionDir, 'subagents');
  mkdirSync(childDir, { recursive: true });
  writeJsonl(join(sessionDir, 'parent.jsonl'), [
    {
      type: 'user',
      uuid: 'parent-user',
      sessionId: 'contract-parent',
      timestamp: '2026-07-28T00:00:01.000Z',
      cwd: '/repo',
      message: {
        role: 'user',
        content: '<command-name>/router-skill</command-name>\nReview the release.',
      },
    },
    {
      type: 'assistant',
      uuid: 'parent-read',
      sessionId: 'contract-parent',
      timestamp: '2026-07-28T00:00:02.000Z',
      cwd: '/repo',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'read-router',
          name: 'Read',
          input: { file_path: '/repo/.agents/skills/router-skill/SKILL.md' },
        }],
      },
    },
    {
      type: 'user',
      uuid: 'parent-read-result',
      sessionId: 'contract-parent',
      timestamp: '2026-07-28T00:00:03.000Z',
      cwd: '/repo',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'read-router', content: '# Router Skill' }],
      },
    },
  ]);
  writeJsonl(join(childDir, 'child.jsonl'), [
    {
      type: 'user',
      uuid: 'child-user',
      sessionId: 'contract-child',
      timestamp: '2026-07-28T00:00:05.000Z',
      cwd: '/repo',
      message: {
        role: 'user',
        content: '<command-name>/executor-skill</command-name>\nRun the parser check.',
      },
    },
    {
      type: 'assistant',
      uuid: 'child-read',
      sessionId: 'contract-child',
      timestamp: '2026-07-28T00:00:06.000Z',
      cwd: '/repo',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'read-executor',
          name: 'Read',
          input: { file_path: '/repo/.agents/skills/executor-skill/SKILL.md' },
        }],
      },
    },
    {
      type: 'user',
      uuid: 'child-read-result',
      sessionId: 'contract-child',
      timestamp: '2026-07-28T00:00:07.000Z',
      cwd: '/repo',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'read-executor', content: '# Executor Skill' }],
      },
    },
    {
      type: 'assistant',
      uuid: 'child-check',
      sessionId: 'contract-child',
      timestamp: '2026-07-28T00:00:08.000Z',
      cwd: '/repo',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'run-check',
          name: 'Bash',
          input: { command: 'node --test parser.test.js' },
        }],
      },
    },
    {
      type: 'user',
      uuid: 'child-check-result',
      sessionId: 'contract-child',
      timestamp: '2026-07-28T00:00:09.000Z',
      cwd: '/repo',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'run-check',
          content: 'Process exited with code 0\nparser tests passed',
        }],
      },
    },
    terminal === 'completed'
      ? {
          type: 'system',
          subtype: 'turn_duration',
          uuid: 'child-completed',
          sessionId: 'contract-child',
          timestamp: '2026-07-28T00:00:10.000Z',
          durationMs: 5000,
        }
      : {
          type: 'turn_aborted',
          uuid: 'child-aborted',
          sessionId: 'contract-child',
          timestamp: '2026-07-28T00:00:10.000Z',
          reason: 'interrupted',
        },
  ]);
}

describe('source-neutral orchestration contract', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omk-orchestration-contract-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const sourceKind of ['codex', 'claude'] as const) {
    for (const terminal of ['completed', 'aborted'] as const) {
      it(`${sourceKind} maps a ${terminal} child trace to one directed edge`, () => {
        const writeFixture = sourceKind === 'codex' ? writeCodexFixture : writeClaudeFixture;
        writeFixture(root, terminal);
        const sessions = loadTraceSessions(root);
        const built = buildObservationExperienceReport({
          sessions,
          segments: sessions.flatMap((session) => segmentBySkill(session)),
          items: [],
          generatedAt: '2026-07-28T00:00:11.000Z',
        });
        const report = normalizeObservationExperienceReport(
          compactObservationExperienceReport(built),
        );
        assert.ok(report);
        assert.deepEqual(
          [...new Set(sessions.map((session) => session.sourceKind))],
          [sourceKind],
        );
        assert.equal(report.storyContexts.length, 1);

        const episode = report.storyContexts[0].episodes[0];
        assert.ok(episode);
        const edges = episode.orchestrationEdges.filter((edge) =>
          edge.edgeKind === 'external_child_session'
        );
        assert.equal(edges.length, 1);

        const edge = edges[0];
        const segmentById = new Map(episode.skillSegments.map((segment) => [segment.id, segment]));
        const parentSegment = segmentById.get(edge.parentSkillSegmentId ?? '');
        const executorSegment = segmentById.get(edge.executorSkillSegmentId ?? '');
        assert.equal(parentSegment?.skillName, 'router-skill');
        assert.equal(parentSegment?.episodeRole, 'router');
        assert.equal(executorSegment?.skillName, 'executor-skill');
        assert.equal(executorSegment?.episodeRole, 'main_executor');
        assert.equal(edge.childSessionId, 'contract-child');
        assert.equal(edge.runnerStartedRef, undefined);
        assert.equal(edge.status, terminal === 'completed' ? 'completed' : 'failed');
        assert.equal(edge.runnerCompletedRef?.label, terminal === 'completed' ? 'turn_completed' : undefined);

        const routerSession = report.sessions.find((session) => session.skillName === 'router-skill');
        assert.ok(routerSession);
        assert.equal(routerSession.indicators.routerDownstreamCompleted, terminal === 'completed' ? 1 : 0);
        assert.equal(routerSession.indicators.routerDownstreamFailed, terminal === 'aborted' ? 1 : 0);
      });
    }
  }

  it('does not infer orchestration from ordinary process output or tool argument prose', () => {
    writeCodexStandaloneFixture(root);
    const sessions = loadTraceSessions(root);
    const report = buildObservationExperienceReport({
      sessions,
      segments: sessions.flatMap((session) => segmentBySkill(session)),
      items: [],
      generatedAt: '2026-07-28T00:00:09.000Z',
    });

    assert.equal(report.storyContexts.length, 1);
    const story = report.storyContexts[0];
    assert.equal(story.subagentDispatches.length, 0);
    assert.equal(
      story.episodes.flatMap((episode) => episode.orchestrationEdges).length,
      0,
    );
    const skillSegments = story.episodes.flatMap((episode) => episode.skillSegments);
    const releaseSegment = skillSegments.find((segment) => segment.skillName === 'release-skill');
    assert.ok(releaseSegment);
    assert.equal(releaseSegment.skillType, 'executor');
    assert.equal(releaseSegment.episodeRole, 'main_executor');

    const session = report.sessions.find((candidate) => candidate.skillName === 'release-skill');
    assert.ok(session);
    assert.equal(session.indicators.routerDownstreamCompleted, 0);
    assert.equal(session.indicators.routerDownstreamFailed, 0);
  });
});
