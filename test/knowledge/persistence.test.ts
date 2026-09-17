import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TraceEvidenceStore } from '../../src/observability/knowledge-extraction/adapters/trace-evidence.js';
import { FileKnowledgeStore } from '../../src/observability/knowledge-extraction/adapters/knowledge-store.js';
import type { KnowledgeWrite } from '../../src/knowledge/store.js';
import { draft, proposal } from './fixtures.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temp(): string { const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-')); roots.push(root); return root; }
const actor = { actorKind: 'human' as const, actorId: 'local-user' };
function command(): KnowledgeWrite & { commandKind: 'append_revision' } {
  return {
    requestId: 'request-1', knowledgeId: 'knowledge-1', expectedGeneration: 0,
    commandKind: 'append_revision', expectedHeadRevisionId: null,
    revision: {
      ...draft(), knowledgeId: 'knowledge-1', revisionId: 'revision-1',
      observationRefs: [], derivations: [], createdAt: '2026-09-14T00:00:00Z', revisedAt: '2026-09-14T00:00:00Z',
      createdBy: actor, revisedBy: actor, revisionReason: '首次提炼',
    },
    grounding: {
      revisionId: 'revision-1', mentions: proposal().mentions, citations: proposal().citations,
      sourceBindings: [{ snapshotId: 'b4165dab-60b1-4f34-a9ea-e73bfa32c35d', sourceVersion: `sha256:${'a'.repeat(64)}`, evidenceRefs: ['record-1'] }],
      reuseRationale: '未来任务参考', identityUncertainties: [],
    },
  };
}

describe('knowledge file transactions', () => {
  it('replays retries before generation checks and rejects changed content under the same request', () => {
    const root = temp();
    const store = new FileKnowledgeStore(root, 'project');
    const input = command();
    const receipt = store.write(input, actor);
    expect(store.write(input, actor)).toEqual(receipt);
    input.revision.title = 'different';
    expect(() => store.write(input, actor)).toThrow('idempotency_conflict');
    expect(store.read(input.knowledgeId).generation).toBe(1);
    expect(readdirSync(root)).toHaveLength(1);
  });
  it('keeps revisions immutable, preserves maintenance separately and rejects a stale editor', () => {
    const store = new FileKnowledgeStore(temp(), 'project');
    const input = command();
    store.write(input, actor);
    store.write({ requestId: 'retain', knowledgeId: input.knowledgeId, expectedGeneration: 1,
      commandKind: 'record_maintenance', maintenance: { revisionId: 'revision-1', actor, at: '2026-09-14T00:01:00Z', reason: '值得复用', choice: 'retain' } }, actor);
    const edit = command();
    edit.requestId = 'edit'; edit.expectedGeneration = 2; edit.expectedHeadRevisionId = 'revision-1';
    edit.revision.revisionId = 'revision-2'; edit.revision.parentRevision = { knowledgeId: 'knowledge-1', revisionId: 'revision-1' };
    edit.revision.title = '修订条件'; edit.grounding.revisionId = 'revision-2';
    store.write(edit, actor);
    expect(store.read('knowledge-1').revisions[0]).toEqual(input.revision);
    expect(store.read('knowledge-1').maintenance).toHaveLength(1);
    expect(store.read('knowledge-1').revisions[1]).not.toHaveProperty('reviewStatus');
    expect(() => store.write({ ...edit, requestId: 'stale-editor' }, actor)).toThrow('conflict');
  });
  it.each(['entity', 'citation', 'source'] as const)('rejects corrupted %s grounding on write and read', (target) => {
    const root = temp(); const store = new FileKnowledgeStore(root, 'project');
    const invalid = command();
    const corrupt = (grounding: typeof invalid.grounding) => {
      if (target === 'entity') grounding.mentions[0].entityId = 'nonexistent';
      if (target === 'citation') grounding.citations[0].evidenceLinkId = 'nonexistent';
      if (target === 'source') grounding.mentions[0].selection.evidenceRef = 'unbound-record';
    };
    corrupt(invalid.grounding);
    expect(() => store.write(invalid, actor)).toThrow('Invalid revision references');
    store.write(command(), actor);
    const path = join(root, readdirSync(root)[0]);
    const stored = JSON.parse(readFileSync(path, 'utf8')); corrupt(stored.grounding[0]);
    writeFileSync(path, JSON.stringify(stored));
    expect(() => store.read('knowledge-1')).toThrow('Invalid revision references');
  });
  it('never overwrites damaged storage or accepts an impersonated author', () => {
    const root = temp();
    const store = new FileKnowledgeStore(root, 'project');
    expect(() => store.write(command(), { ...actor, actorId: 'another' })).toThrow('unauthorized');
    expect(readdirSync(root)).toEqual([]);
    store.write(command(), actor);
    const path = join(root, readdirSync(root)[0]);
    writeFileSync(path, '{broken');
    expect(() => store.write(command(), actor)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{broken');
  });
});

describe('selected Codex evidence snapshots', () => {
  function source(root: string): string {
    const path = join(root, 'source.jsonl');
    writeFileSync(path, [
      { type: 'session_meta', payload: { id: 'session-one' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '记录已收到' }] } },
    ].map((record) => JSON.stringify(record)).join('\n'));
    return path;
  }
  it('keeps exact selected records and provenance without following later source changes', () => {
    const root = temp(); const path = source(root);
    const store = new TraceEvidenceStore(join(root, 'evidence'));
    const captured = store.capture({ path, startRecord: 1, endRecord: 1 });
    expect(captured.records.map((record) => record.recordIndex)).toEqual([1]);
    expect(captured.excerpts.some((excerpt) => excerpt.text === 'Alpha 使用 Beta')).toBe(true);
    expect(captured.limitations.length).toBeGreaterThan(0);
    writeFileSync(path, 'changed');
    expect(store.read(captured.snapshotId, captured.sourceVersion)).toEqual({ status: 'available', window: captured });
    expect(store.read(captured.snapshotId, `sha256:${'0'.repeat(64)}`)).toMatchObject({ status: 'unavailable', reason: 'version_mismatch' });
    store.delete(captured.snapshotId);
    expect(store.read(captured.snapshotId)).toMatchObject({ status: 'unavailable', reason: 'deleted' });
    expect(readFileSync(path, 'utf8')).toBe('changed');
  });
  it('keeps unknown raw envelopes local instead of exposing them as generation excerpts', () => {
    const root = temp(); const path = source(root);
    writeFileSync(path, readFileSync(path, 'utf8') + '\n' + JSON.stringify({ type: 'unknown_event', payload: { privateMetadata: 'must-stay-local' } }));
    const captured = new TraceEvidenceStore(join(root, 'evidence')).capture({ path });
    expect(JSON.stringify(captured.records)).toContain('must-stay-local');
    expect(JSON.stringify(captured.excerpts)).not.toContain('must-stay-local');
    expect(captured.excerpts.some((entry) => entry.text === 'Alpha 使用 Beta')).toBe(true);
  });
  it('detects corruption and cancels without snapshot pollution', () => {
    const root = temp(); const path = source(root); const evidenceRoot = join(root, 'evidence');
    const store = new TraceEvidenceStore(evidenceRoot);
    expect(() => store.capture({ path }, AbortSignal.abort())).toThrow();
    const captured = store.capture({ path });
    writeFileSync(join(evidenceRoot, `${captured.snapshotId}.json`), '{}');
    expect(store.read(captured.snapshotId)).toMatchObject({ status: 'unavailable', reason: 'invalid_source' });
    expect(readdirSync(evidenceRoot)).toHaveLength(1);
  });
});
