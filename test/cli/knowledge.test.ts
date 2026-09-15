import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserSettingsStore } from '../../src/evidence/storage/user-settings.js';
import ObserveKnowledge from '../../src/cli/commands/observe/knowledge.js';
import { runCommand } from '../helpers/run-command.js';

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
});
