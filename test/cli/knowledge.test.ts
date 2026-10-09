import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserSettingsStore } from '../../src/evidence/storage/user-settings.js';
import ObserveKnowledge from '../../src/cli/commands/observe/knowledge.js';
import { runCommand } from '../helpers/run-command.js';
import { createLocalKnowledgeApplication } from '../../src/observability/knowledge-extraction/local.js';
import { modelWindow } from '../knowledge/fixtures.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('observe knowledge command wiring', () => {
  it('captures one selected source, inspects it and deletes its snapshot through shared operations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-cli-')); roots.push(root);
    const path = join(root, 'trace.jsonl');
    const workspace = join(root, 'knowledge');
    writeFileSync(path, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请记住项目规则' }] } }));
    const output = await runCommand(ObserveKnowledge, ['capture', '--workspace', workspace, '--source', path, '--json'], { cwd: root });
    const captured = JSON.parse(output.stdout);
    expect(captured.records).toHaveLength(1);
    const read = await runCommand(ObserveKnowledge, ['source', '--workspace', workspace, '--snapshot', captured.snapshotId, '--json'], { cwd: root });
    expect(JSON.parse(read.stdout).status).toBe('available');
    await runCommand(ObserveKnowledge, ['delete-source', '--workspace', workspace, '--snapshot', captured.snapshotId], { cwd: root });
    const deleted = await runCommand(ObserveKnowledge, ['source', '--workspace', workspace, '--snapshot', captured.snapshotId, '--json'], { cwd: root });
    expect(JSON.parse(deleted.stdout)).toMatchObject({ status: 'unavailable', reason: 'deleted' });
  });
  it('reads the same saved workspace as Studio when the flag is omitted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-settings-cli-')); roots.push(root);
    vi.stubEnv('OMK_HOME', root);
    const workspace = join(root, 'chosen');
    new UserSettingsStore(root).save({ schemaVersion: 1, knowledge: { workspace } }, 'missing');
    const source = join(root, 'source.jsonl');
    writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fixture' }] } }));
    const captured = JSON.parse((await runCommand(ObserveKnowledge, ['capture', '--source', source, '--json'], { cwd: root })).stdout);
    const result = await runCommand(ObserveKnowledge, ['source', '--workspace', workspace, '--snapshot', captured.snapshotId, '--json'], { cwd: root });
    expect(JSON.parse(result.stdout).status).toBe('available');
  });
  it('rejects missing operation-specific parameters before accessing storage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-cli-')); roots.push(root);
    await expect(runCommand(ObserveKnowledge, ['retain', '--workspace', root], { cwd: root })).rejects.toMatchObject({ code: 2 });
  });
  it('inspects and corrects an independent entity result, then explicitly binds a new knowledge revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-entities-cli-')); roots.push(root);
    const workspace = join(root, 'knowledge'); const source = join(root, 'trace.jsonl');
    writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }));
    const app = createLocalKnowledgeApplication(workspace); const snapshot = app.capture({ path: source });
    const run = await app.generate(snapshot.snapshotId, { executor: 'fixture', model: 'fixture',
      generate: async (_system, input) => ({ output: JSON.stringify(modelWindow()).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 1 }) });
    const base = ['--workspace', workspace, '--lang', 'zh'];
    const inspect = await runCommand(ObserveKnowledge, ['entities', ...base, '--analysis', run.runId], { cwd: root });
    expect(inspect.stdout).toContain('实体分析'); expect(inspect.stdout).toContain('Alpha');
    const before = app.entities(run.runId);
    const edit = { entities: structuredClone(before.revision.entities), mentions: before.revision.mentions };
    edit.entities[0].label = '项目 Alpha';
    const path = join(root, 'correction.json'); writeFileSync(path, JSON.stringify(edit));
    const args = ['correct-entities', ...base, '--analysis', run.runId, '--entity-revision', before.revision.revisionId,
      '--generation', '1', '--input', path, '--reason', '核对项目名称', '--json'];
    const corrected = JSON.parse((await runCommand(ObserveKnowledge, args, { cwd: root })).stdout);
    expect(corrected.history.generation).toBe(2);
    const old = app.detail(run.committed[0].knowledgeId);
    expect(old.revision.entities[0].label).toBe('Alpha');
    await expect(runCommand(ObserveKnowledge, args, { cwd: root })).rejects.toMatchObject({ code: 1 });
    const draft = { title: old.revision.title, entities: corrected.revision.entities.map(({ entityId, label, description }: { entityId: string; label: string; description: string }) => ({ entityId, label, description })),
      content: old.revision.content, evidence: old.revision.evidence };
    const draftPath = join(root, 'knowledge.json'); writeFileSync(draftPath, JSON.stringify(draft));
    const applied = JSON.parse((await runCommand(ObserveKnowledge, ['apply-entities', ...base, '--id', old.revision.knowledgeId,
      '--revision', old.revision.revisionId, '--generation', '1', '--analysis', run.runId,
      '--entity-revision', corrected.revision.revisionId, '--input', draftPath, '--identity-uncertainties', '[]', '--reason', '明确知识主体', '--json'], { cwd: root })).stdout);
    expect(applied.revision.entities[0].label).toBe('项目 Alpha');
    expect(applied.grounding.entityAnalysisRef.revisionId).toBe(corrected.revision.revisionId);
    expect(applied.history.revisions[0]).toEqual(old.revision);
    await expect(runCommand(ObserveKnowledge, ['correct-entities', ...base, '--analysis', run.runId], { cwd: root })).rejects.toMatchObject({ code: 2 });
  });
  it('rejects removed migration operations and flags before touching the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-current-cli-')); roots.push(root);
    for (const args of [['migrate'], ['list', '--dry-run'], ['list', '--backup-dir', '/outside'], ['list', '--preview-digest', 'digest']]) {
      await expect(runCommand(ObserveKnowledge, [...args, '--workspace', join(root, 'knowledge')], { cwd: root })).rejects.toMatchObject({ code: args[0] === 'migrate' ? 1 : 2 });
    }
    expect(existsSync(join(root, 'knowledge'))).toBe(false);
  });
});
