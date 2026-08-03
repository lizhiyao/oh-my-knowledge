import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
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

describe('Knowledge Debugger projection', () => {
  it('projects injected AGENTS instructions as project knowledge with provenance', () => {
    const [knowledge] = projectKnowledgeEvidence([
      event('e1', 'runtime_context', {
        timestamp: '2026-08-03T00:00:01.000Z',
        fullText: '# AGENTS.md instructions for /repo\n<INSTRUCTIONS>\nAlways run tests.\n</INSTRUCTIONS>',
      }),
    ]);

    assert.equal(knowledge.knowledgeKind, 'project_instruction');
    assert.equal(knowledge.accessKind, 'injected');
    assert.equal(knowledge.label, 'AGENTS.md');
    assert.equal(knowledge.sourceLocator, 'runtime-context:/repo');
    assert.equal(knowledge.contentHash?.length, 64);
    assert.equal(knowledge.evidenceRefs[0].id, 'e1');
  });

  it('projects every AGENTS section even when runtime metadata precedes it', () => {
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

  it('aggregates repeated access to the same observed content', () => {
    const projected = projectKnowledgeEvidence([
      event('e1', 'tool_use', {
        callInstanceId: 'call-1',
        toolName: 'Read',
        fullText: JSON.stringify({ file_path: '/repo/config.json' }),
      }),
      event('e2', 'tool_result', {
        callInstanceId: 'call-1',
        timestamp: '2026-08-03T00:00:02.000Z',
        fullText: '{"mode":"strict"}',
      }),
      event('e3', 'tool_use', {
        callInstanceId: 'call-2',
        toolName: 'Read',
        fullText: JSON.stringify({ file_path: '/repo/config.json' }),
      }),
      event('e4', 'tool_result', {
        callInstanceId: 'call-2',
        timestamp: '2026-08-03T00:00:04.000Z',
        fullText: '{"mode":"strict"}',
      }),
    ]);

    assert.equal(projected.length, 1);
    assert.equal(projected[0].accessCount, 2);
    assert.equal(projected[0].evidenceRefs.length, 2);
    assert.equal(projected[0].firstSeen, '2026-08-03T00:00:02.000Z');
    assert.equal(projected[0].lastSeen, '2026-08-03T00:00:04.000Z');
  });
});
