import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTO_EXTRACTION_WORKFLOW, AutoExtractionConsentSchema, ConversationAutoExtraction } from '../../src/knowledge/application/auto-extraction.js';
import { configuredKnowledgeGenerationModel } from '../../src/knowledge/adapters/generation-executor.js';
import type { ExecutorArchiveProducer } from '../../src/executors/contracts/archive.js';
import type { ConversationCatalog } from '../../src/observability/conversation/catalog.js';
import { executeAutoExtractionAction } from '../../src/studio/application/knowledge/auto-extraction.js';
import { testDirectory } from '../helpers/temp-directory.js';

afterEach(() => vi.restoreAllMocks());
const sha = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const reason = 'explicit_stages_required';
const unsupported = (threadId: string) => ({ schemaStatus: 'unsupported', threadId, enabled: false, reason });
function put(root: string, path: string, bytes: string | Uint8Array) {
  const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes); return file;
}
function fingerprint(root: string) {
  const files: { path: string; digest: string }[] = [], directories: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (lstatSync(path).isDirectory()) { directories.push(relative(root, path)); visit(path); }
      else files.push({ path: relative(root, path), digest: sha(readFileSync(path)) });
    }
  };
  visit(root); return { files, directories };
}
function fixture() {
  const root = testDirectory('omk-retired-auto-'), workspace = join(root, 'knowledge');
  const catalog = {
    listConversations: vi.fn(async () => { throw new Error('Retired automation must not list conversations.'); }),
    getConversation: vi.fn(async () => { throw new Error('Retired automation must not inspect a conversation.'); }),
    loadTaskTrajectory: vi.fn(async () => { throw new Error('Retired automation must not read trajectories.'); }),
    loadTaskMessageRecords: vi.fn(async () => { throw new Error('Retired automation must not read messages.'); }),
  } satisfies ConversationCatalog;
  const native = vi.fn(async () => { throw new Error('Retired automation must not dispatch.'); });
  const evidence = { producerId: 'authored-retirement-fixture', producerRevision: 'v1', sourceChannels: [], maxOutcomeJsonBytes: 1024, proof: { nativeObserved: false } };
  const producer = {
    assertCapabilities: vi.fn(), inspect: vi.fn(() => evidence),
    configure: vi.fn(() => ({ evidence, execute: native })),
  } satisfies ExecutorArchiveProducer;
  const model = configuredKnowledgeGenerationModel('codex', 'authored-no-native', producer);
  const inspect = vi.spyOn(model, 'inspect'), invoke = vi.spyOn(model, 'invoke');
  const createModel = vi.fn(() => model), now = vi.fn(() => Date.parse('2026-10-30T00:00:00Z'));
  const service = new ConversationAutoExtraction(catalog, { model: createModel, now, stableMs: 1, intervalMs: 1 });
  const consent = { workflowId: AUTO_EXTRACTION_WORKFLOW, token: 'historical-approved-token', executor: 'codex' as const, model: model.model, maxCalls: 20 };
  const untouched = () => {
    for (const method of Object.values(catalog)) expect(method).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled(); expect(createModel).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
    expect(producer.assertCapabilities).not.toHaveBeenCalled(); expect(producer.inspect).not.toHaveBeenCalled();
    expect(producer.configure).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
  };
  return { root, workspace, service, consent, untouched };
}

/** Authored legacy protocol-shaped files exercise byte custody only; these do not establish a real native invocation. */
function legacyFiles(f: ReturnType<typeof fixture>) {
  const threadId = 'old-thread', permissionId = randomUUID(), runId = randomUUID(), snapshotId = randomUUID();
  const sourceVersion = sha('historical source'), sourceSetId = sha('historical source set'), sources = [{ snapshotId, sourceVersion }];
  const at = '2026-10-29T00:00:00.000Z';
  const profileBindings = (['body', 'association'] as const).map(stageKind => ({ stageKind, profileId: sha(`${stageKind}-profile`),
    promptVersion: stageKind === 'body' ? '8' : '7', wireId: sha(`${stageKind}-wire`), systemDigest: sha(`${stageKind}-system`), wireSchemaDigest: sha('{}'), producerBinding: {} }));
  const permission = { sourceScopeId: 'historical-conversation', profileBindings, schemaVersion: 3, workflowId: 'knowledge-body-first/v3',
    permissionId, threadId, executor: 'codex', model: f.consent.model, maxCalls: 20, enabledAt: at, expiresAt: '2026-10-30T00:00:00.000Z',
    ledgerVersion: 'conversation-phase-invocations/v3' };
  put(f.workspace, `auto-extraction/${sha(JSON.stringify(threadId)).slice(7)}.json`, JSON.stringify({ ...permission,
    automationKind: 'conversation-knowledge-extraction', schemaStatus: 'current', owner: randomUUID(), pid: process.pid, hostname: hostname(),
    callsUsed: 2, enabled: true, reason: 'generating', checkedTurns: ['turn-0'], initialTurns: [], attemptedVersions: [sourceVersion],
    lastRunId: runId, notBefore: '2026-10-29T01:00:00.000Z' }, null, 1) + '\r\n');
  put(f.workspace, `auto-extraction/permission-${permissionId}.json`, JSON.stringify({ ...permission,
    automationKind: 'conversation-knowledge-permission', token: f.consent.token, initialTurns: ['turn-1'],
    futureWindow: { newTurns: 3, precedingTurns: 2, stableMs: 30_000 } }) + '\n');
  put(f.workspace, `auto-extraction/schedule-${permissionId}-${runId}.json`, JSON.stringify({ schemaVersion: 3,
    automationKind: 'conversation-knowledge-schedule', workflowId: permission.workflowId, permissionId, threadId, runId,
    executor: permission.executor, model: permission.model, sourceSetId, sources, sourceVersion, turnIds: ['turn-1'], scheduledAt: at, firstCallNumber: 1 }));
  for (const [index, stageKind] of (['body', 'association'] as const).entries()) {
    const invocationId = randomUUID(), binding = profileBindings[index];
    put(f.workspace, `auto-extraction/phase-${permissionId}-${invocationId}.json`, JSON.stringify({ schemaVersion: 3,
      automationKind: 'conversation-knowledge-invocation', ledgerVersion: permission.ledgerVersion, permissionId, threadId, runId, invocationId,
      stageKind, requestDigest: sha(`${stageKind}-request`), turnIds: ['turn-1'], sourceVersion, sourceSetId, sources,
      request: { input: '{}', system: 'Original approved system bytes', inputDigest: sha('{}'), profileId: binding.profileId,
        wireId: binding.wireId, promptVersion: binding.promptVersion, wireSchema: {}, producer: {} },
      callNumber: index + 1, at, evidenceKind: 'dispatch-reservation' }) + '\n');
  }
  put(f.workspace, `generation-journals/${runId}.json`, '{"schemaVersion":3,"workflowId":"knowledge-body-first/v3","status":"active","dispatchOutcome":"unknown","mustNotRedispatch":true}\n');
  put(f.workspace, `generation-journals/outcomes/${runId}.native`, Buffer.from([0, 255, 13, 10, 240, 159, 153, 130]));
  put(f.workspace, `auto-extraction/${sha(JSON.stringify('malformed-thread')).slice(7)}.json`, '{ malformed original; do not read or repair\n');
  return threadId;
}

describe('retired conversation auto extraction requires explicit stages', () => {
  it('owns no timer, reads no sources and creates no workspace, including after repeated close', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval'), f = fixture();
    expect(interval).not.toHaveBeenCalled(); interval.mockRestore();
    expect(f.service.status(f.workspace, 'thread')).toEqual(unsupported('thread'));
    expect(f.service.stop(f.workspace, 'thread')).toEqual(unsupported('thread'));
    await f.service.tick(); await f.service.tick();
    await expect(f.service.preview('thread', f.consent)).rejects.toThrow(reason);
    await expect(f.service.enable(f.workspace, 'thread', f.consent)).rejects.toThrow(reason);
    f.service.close(); f.service.close();
    await f.service.tick();
    await expect(f.service.preview('thread', f.consent)).rejects.toThrow(reason);
    await expect(f.service.enable(f.workspace, 'thread', f.consent)).rejects.toThrow(reason);
    f.untouched(); expect(existsSync(f.workspace)).toBe(false); expect(readdirSync(f.root)).toEqual([]);
  });

  it('leaves old consent, reservations, unknown dispatches and native bytes untouched without consuming their allowance', async () => {
    const f = fixture(), threadId = legacyFiles(f), original = fingerprint(f.workspace);
    expect(f.service.status(f.workspace, threadId)).toEqual(unsupported(threadId));
    expect(f.service.stop(f.workspace, threadId)).toEqual(unsupported(threadId));
    expect(f.service.status(f.workspace, 'malformed-thread')).toEqual(unsupported('malformed-thread'));
    await expect(f.service.enable(f.workspace, threadId, f.consent)).rejects.toThrow(reason);
    await expect(f.service.preview(threadId, f.consent)).rejects.toThrow(reason);
    await f.service.tick(); f.service.close(); f.service.close(); await f.service.tick();
    expect(fingerprint(f.workspace)).toEqual(original); f.untouched();
  });

  it('rejects valid host preview and legacy enable while status and stop remain independent read-only scope projections', async () => {
    const f = fixture(), threadId = legacyFiles(f), original = fingerprint(f.workspace), emptyRoot = join(f.root, 'empty-workspace');
    expect(AUTO_EXTRACTION_WORKFLOW).toBe('knowledge-body-first/v3');
    expect(AutoExtractionConsentSchema.parse(f.consent)).toEqual(f.consent);
    await expect(executeAutoExtractionAction({ operation: 'preview', threadId, executor: f.consent.executor, model: f.consent.model }, f.service)).rejects.toThrow(reason);
    await expect(executeAutoExtractionAction({ operation: 'enable', workspace: f.workspace, threadId, ...f.consent }, f.service)).rejects.toThrow(reason);
    for (const operation of ['status', 'stop'] as const) {
      expect(executeAutoExtractionAction({ operation, workspace: f.workspace, threadId }, f.service)).toEqual(unsupported(threadId));
      expect(executeAutoExtractionAction({ operation, workspace: emptyRoot, threadId: 'another-thread' }, f.service)).toEqual(unsupported('another-thread'));
    }
    expect(existsSync(emptyRoot)).toBe(false); expect(fingerprint(f.workspace)).toEqual(original); f.untouched();
  });

  it('keeps strict host payload validation before the retired service boundary', () => {
    const f = fixture(), preview = vi.spyOn(f.service, 'preview'), enable = vi.spyOn(f.service, 'enable'), status = vi.spyOn(f.service, 'status');
    for (const input of [
      { operation: 'status', workspace: ' ', threadId: 'thread' },
      { operation: 'status', workspace: f.workspace, threadId: '' },
      { operation: 'status', workspace: f.workspace, threadId: 'thread', actor: { actorKind: 'human', actorId: 'client' } },
      { operation: 'preview', threadId: 'thread', executor: 'script', model: f.consent.model },
      { operation: 'preview', threadId: 'thread', executor: f.consent.executor, model: f.consent.model, workspace: f.workspace },
      { operation: 'enable', workspace: f.workspace, threadId: 'thread', token: f.consent.token, executor: f.consent.executor, model: f.consent.model, maxCalls: 20 },
      { operation: 'enable', workspace: f.workspace, threadId: 'thread', ...f.consent, workflowId: 'knowledge-body-first/v4' },
      { operation: 'enable', workspace: f.workspace, threadId: 'thread', ...f.consent, maxCalls: 0 },
    ]) expect(() => executeAutoExtractionAction(input, f.service)).toThrow();
    expect(preview).not.toHaveBeenCalled(); expect(enable).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
    f.untouched(); expect(existsSync(f.workspace)).toBe(false);
  });
});
