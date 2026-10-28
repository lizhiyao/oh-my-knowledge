import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ObserveKnowledge from '../../src/cli/commands/observe/knowledge.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { TraceEvidenceStore } from '../../src/knowledge/adapters/trace-evidence.js';
import { FileKnowledgeAssociationStore } from '../../src/knowledge/adapters/association-store.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { knowledgeBodyDigest } from '../../src/knowledge/adapters/body-digest.js';
import type { KnowledgeActor, KnowledgeDraft } from '../../src/knowledge/contracts.js';
import * as executor from '../../src/knowledge/adapters/generation-executor.js';
import { UserSettingsStore } from '../../src/evidence/storage/user-settings.js';
import { runCommand } from '../helpers/run-command.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function workspaceBytes(root: string, base = root): [string, string][] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? workspaceBytes(join(root, entry.name), base)
    : [[relative(base, join(root, entry.name)), createHash('sha256').update(readFileSync(join(root, entry.name))).digest('hex')] as [string, string]]).sort((a, b) => a[0].localeCompare(b[0]));
}
function persistedBody() {
  const root = mkdtempSync(join(tmpdir(), 'omk-body-retrieve-cli-')); roots.push(root);
  const workspace = join(root, 'workspace'), source = join(root, 'source.jsonl'), text = '🙂 用户报告仅初始化时 v-model 不更新；用户输入不受影响，成本未知。';
  writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }));
  const evidence = new TraceEvidenceStore(join(workspace, 'sources'), workspace), snapshot = evidence.capture({ path: source });
  const quote = snapshot.excerpts[0].text;
  const draft: KnowledgeDraft = { title: '初始化时的 v-model 报告', reuseRationale: '保留已报告条件与待验证边界。',
    content: { segments: [{ segmentId: 'initialization', text, evidence: [{ source: { snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion },
      selection: { evidenceRef: snapshot.excerpts[0].evidenceRef, quote, start: 0, end: quote.length }, basis: 'source_assertion', interpretation: '来源报告，未独立验证。' }] }] } };
  const actor: KnowledgeActor = { actorKind: 'human', actorId: 'authored-test-fixture' }, at = '2026-01-01T00:00:00Z', knowledgeId = randomUUID(), revisionId = randomUUID();
  const store = new FileKnowledgeStore(join(workspace, 'items'), 'local', workspace);
  store.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId, expectedGeneration: 0, expectedHeadRevisionId: null,
    revision: { ...draft, knowledgeId, revisionId, bodyDigest: knowledgeBodyDigest(draft), observationRefs: [], derivations: [], createdAt: at,
      createdBy: actor, revisedAt: at, revisedBy: actor, revisionReason: 'Authored CLI retrieval fixture, not native generation.' } }, actor);
  vi.stubEnv('OMK_HOME', join(root, 'home')); vi.stubEnv('OMK_SKIP_UPDATE_CHECK', '1');
  vi.spyOn(executor, 'configuredKnowledgeGenerationModel').mockImplementation(() => { throw new Error('Retrieval must not configure an executor.'); });
  const command = (extra: string[] = []) => runCommand(ObserveKnowledge, ['retrieve', '--workspace', workspace, '--query', '初始化时 v-model 的条件是什么？', ...extra], { cwd: root });
  return { root, workspace, snapshot, draft, evidence, knowledgeId, revisionId, command,
    failedAssociations() {
      const directory = join(workspace, 'associations'), associations = new FileKnowledgeAssociationStore(directory, 'local', store,
        new FileEntityAnalysisStore(join(workspace, 'entities'), workspace), workspace);
      associations.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId, expectedGeneration: 0, expectedHeadRevisionId: null,
        revision: { revisionId: randomUUID(), bodyRef: { knowledgeId, revisionId, bodyDigest: knowledgeBodyDigest(draft) }, status: 'failed',
          reviewStatus: 'pending', segmentEntityRefs: [], issues: ['Authored association failure.'], revisedAt: at, revisedBy: actor, revisionReason: 'Authored failure fixture.' } }, actor);
      const file = join(directory, readdirSync(directory).find(name => name.endsWith('.json'))!);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ storeKind: 'knowledge-association-history', knowledgeId });
      return file;
    },
    retain() { store.write({ commandKind: 'record_maintenance', requestId: randomUUID(), knowledgeId, expectedGeneration: 1,
      maintenance: { revisionId, actor, choice: 'retain', at, reason: 'Authored explicit maintenance choice, not truth certification.' } }, actor); } };
}

describe('body retrieve command wiring', () => {
  it('reads persisted canonical segments as one budgeted JSON line, retains source identities and leaves all workspace bytes unchanged', async () => {
    const f = persistedBody(), before = workspaceBytes(f.workspace);
    expect(JSON.parse((await f.command()).stdout).items).toEqual([]);
    const output = await f.command(['--include-candidates', '--json', '--snapshot', f.snapshot.snapshotId, '--source-version', f.snapshot.sourceVersion]);
    const result = JSON.parse(output.stdout);
    expect(result).toMatchObject({ projectionKind: 'knowledge-body-segments', schemaVersion: 1,
      knowledge: [{ bodyRef: { knowledgeId: f.knowledgeId, revisionId: f.revisionId, bodyDigest: knowledgeBodyDigest(f.draft) }, choice: null,
        derivedAssociations: { status: 'absent', reviewStatus: 'pending' } }], items: [{ evidenceChecks: [{ positionStatus: 'matched' }] }] });
    expect(result.items[0].segment).toEqual(f.draft.content.segments[0]);
    expect(output.stdout.trimEnd().split('\n')).toHaveLength(1); expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(8192);
    expect(workspaceBytes(f.workspace)).toEqual(before); expect(executor.configuredKnowledgeGenerationModel).not.toHaveBeenCalled();
    f.retain(); const retained = workspaceBytes(f.workspace);
    expect(JSON.parse((await f.command()).stdout).knowledge[0].choice).toBe('retain');
    expect(workspaceBytes(f.workspace)).toEqual(retained);
  });
  it('keeps the stored body readable after source deletion while marking citation availability honestly', async () => {
    const f = persistedBody(); f.retain(); f.evidence.delete(f.snapshot.snapshotId); const before = workspaceBytes(f.workspace);
    const result = JSON.parse((await f.command(['--snapshot', f.snapshot.snapshotId])).stdout);
    expect(result).toMatchObject({ sources: [{ status: 'unavailable', reason: 'deleted' }], items: [{ evidenceChecks: [{ positionStatus: 'unavailable' }] }] });
    expect(result.items[0].segment).toEqual(f.draft.content.segments[0]); expect(workspaceBytes(f.workspace)).toEqual(before);
  });
  it('renders complete canonical text with exact evidence identities while keeping default and explicit JSON bytes identical', async () => {
    const f = persistedBody(); f.retain(); const before = workspaceBytes(f.workspace);
    const json = await f.command(), explicit = await f.command(['--format', 'json', '--json']);
    expect(explicit.stdout).toBe(json.stdout);
    const readback = JSON.parse(json.stdout), segment = f.draft.content.segments[0], evidence = segment.evidence[0];
    expect(readback.items[0].segment).toEqual(segment);
    const output = await f.command(['--format', 'text', '--max-bytes', '8192']);
    expect(output.stdout).toContain('viewKind: knowledge-body-text/v1');
    expect(output.stdout).toContain('packingPolicyId: knowledge-body-text-packing/v1');
    expect(output.stdout).toContain('quoteDisplay: omitted');
    for (const value of [segment.text, f.knowledgeId, f.revisionId, knowledgeBodyDigest(f.draft), f.snapshot.snapshotId,
      f.snapshot.sourceVersion, evidence.selection.evidenceRef, evidence.basis, `utf16=[${evidence.selection.start},${evidence.selection.end})`]) {
      expect(output.stdout).toContain(value);
    }
    expect(output.stdout).toContain('matched');
    expect(output.stdout.endsWith('endView: knowledge-body-text/v1\n')).toBe(true);
    expect(output.stdout.endsWith('\n')).toBe(true); expect(output.stdout.endsWith('\n\n')).toBe(false);
    expect(Buffer.byteLength(output.stdout, 'utf8')).toBeLessThanOrEqual(8192);
    expect(workspaceBytes(f.workspace)).toEqual(before); expect(executor.configuredKnowledgeGenerationModel).not.toHaveBeenCalled();
  });
  it('keeps independent body reads available through failed or unreadable derived records and ignores unrelated corrupt catalogs', async () => {
    const f = persistedBody(); f.retain(); const file = f.failedAssociations();
    expect(JSON.parse((await f.command()).stdout).knowledge[0].derivedAssociations.status).toBe('failed');
    writeFileSync(file, '{invalid'); const before = workspaceBytes(f.workspace);
    const corrupt = JSON.parse((await f.command()).stdout);
    expect(corrupt.items[0].segment).toEqual(f.draft.content.segments[0]); expect(corrupt.knowledge[0].derivedAssociations.status).toBe('failed');
    expect(JSON.parse((await f.command(['--entity-id', randomUUID()])).stdout).items).toEqual([]);
    expect(workspaceBytes(f.workspace)).toEqual(before);
    const other = persistedBody(); other.retain(); const directory = join(other.workspace, 'associations'); mkdirSync(directory);
    writeFileSync(join(directory, 'unrelated-corrupt.json'), '{invalid'); const unrelated = workspaceBytes(other.workspace);
    const result = JSON.parse((await other.command()).stdout);
    expect(result.items).toHaveLength(1); expect(result.knowledge[0].derivedAssociations.status).toBe('absent');
    expect(workspaceBytes(other.workspace)).toEqual(unrelated);
  });
  it('rejects malformed and mutation/generation flags as parameter errors before reading settings or creating a workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-retrieve-args-')); roots.push(root); const workspace = join(root, 'absent');
    vi.stubEnv('OMK_HOME', root); writeFileSync(join(root, 'settings.json'), '{invalid');
    const settings = vi.spyOn(UserSettingsStore.prototype, 'resolve');
    const invoke = (args: string[]) => runCommand(ObserveKnowledge, ['retrieve', '--workspace', workspace, ...args], { cwd: root });
    for (const args of [[], ['--query', 'x', '--max-bytes', '1023'], ['--query', 'x', '--source-version', `sha256:${'a'.repeat(64)}`],
      ['--query', 'x', '--executor', 'codex'], ['--query', 'x', '--reason', 'must not mutate'],
      ['--query', 'x', '--format', 'text', '--json'], ['--query', 'x', '--format', 'yaml']]) {
      await expect(invoke(args)).rejects.toMatchObject({ code: 2 });
    }
    for (const args of [['list', '--workspace', workspace, '--format', 'json'], ['schema', '--format', 'text'],
      ['study', '--format', 'text', '--evidence', join(root, 'absent-evidence.json')]]) {
      await expect(runCommand(ObserveKnowledge, args, { cwd: root })).rejects.toMatchObject({ code: 2 });
    }
    expect(settings).not.toHaveBeenCalled();
    expect(existsSync(workspace)).toBe(false); expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe('{invalid');
  });
});
