import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ObserveKnowledge from '../../src/cli/commands/observe/knowledge.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import * as executor from '../../src/knowledge/adapters/generation-executor.js';
import { runCommand } from '../helpers/run-command.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
describe('explicit workspace migration command', () => {
  it('requires both explicit roots before settings and rejects model flags', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-migrate-args-')); roots.push(root); vi.stubEnv('OMK_HOME', root);
    writeFileSync(join(root, 'settings.json'), '{invalid');
    for (const args of [[], ['--from-workspace', './old'], ['--workspace', './new'],
      ['--from-workspace', './old', '--workspace', './new', '--model', 'forbidden']]) {
      await expect(runCommand(ObserveKnowledge, ['migrate', ...args], { cwd: root })).rejects.toMatchObject({ code: 2 });
    }
    expect(existsSync(join(root, 'new'))).toBe(false); expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe('{invalid');
  });
  it('uses the public migration contract, preserves old bytes and creates only pending mechanical body revisions without models', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-migrate-cli-')); roots.push(root); const old = join(root, 'old'), target = join(root, 'new');
    mkdirSync(join(old, 'items'), { recursive: true }); vi.stubEnv('OMK_HOME', root); writeFileSync(join(root, 'settings.json'), '{invalid');
    vi.spyOn(executor, 'configuredKnowledgeGenerationModel').mockImplementation(() => { throw new Error('Migration cannot configure a model.'); });
    const actor = { actorKind: 'human', actorId: 'authored-migration-fixture' }, at = '2026-01-01T00:00:00Z', unknown = { timeKind: 'unknown', reason: 'No time in authored source.' };
    const envelope = { storeKind: 'knowledge-item-history', schemaVersion: 2, namespace: 'local', knowledgeId: 'old', generation: 1, writeHeadRevisionId: 'r1',
      revisions: [{ knowledgeId: 'old', revisionId: 'r1', title: 'Authored old claim', entities: [{ entityId: 'e', label: 'Alpha', description: 'Authored object.' }],
        content: { statements: [{ statementId: 's', subject: { entityId: 'e' }, relation: 'not established', modality: 'descriptive', polarity: 'negative',
          context: { scenario: 'Authored fixture', conditions: ['Only this case'], exceptions: [], unknowns: ['Not verified'], occurredDuring: unknown, validDuring: unknown } }], organization: { knowledgeKind: 'fact' } },
        evidence: [{ evidenceLinkId: 'l', evidenceRef: 'e1', statementIds: ['s'], relation: 'supports', basis: 'source_assertion', interpretation: 'Authored report.' }],
        observationRefs: [], derivations: [], createdAt: at, createdBy: actor, revisedAt: at, revisedBy: actor, revisionReason: 'Authored fixture.' }],
      grounding: [{ revisionId: 'r1', mentions: [{ mentionId: 'm', entityId: 'e', selection: { evidenceRef: 'e1', start: 0, end: 5, quote: 'Alpha' }, basis: 'explicit', rationale: 'Authored mention.' }],
        citations: [{ evidenceLinkId: 'l', selection: { evidenceRef: 'e1', start: 0, end: 5, quote: 'Alpha' } }],
        sourceBindings: [{ snapshotId: randomUUID(), sourceVersion: hash('authored source'), evidenceRefs: ['e1'] }], reuseRationale: 'Authored reuse.', identityUncertainties: [] }],
      maintenance: [], receipts: [{ requestId: 'create', commandDigest: 'authored', committedGeneration: 1, revisionId: 'r1' }] };
    const path = join(old, 'items', `${hash(canonicalJson(['local', 'old'])).slice(7)}.json`), original = JSON.stringify(envelope, null, 1) + '\n'; writeFileSync(path, original);
    const report = JSON.parse((await runCommand(ObserveKnowledge, ['migrate', '--from-workspace', old, '--workspace', target, '--json'], { cwd: root })).stdout);
    expect(report).toMatchObject({ migratedRevisions: 1, pending: true, originalBytesPreserved: true, modelCalls: 0, semanticAcceptance: false });
    expect(readFileSync(path, 'utf8')).toBe(original); const item = new FileKnowledgeStore(join(target, 'items'), 'local', target).list()[0];
    expect(item.schemaVersion).toBe(3); expect(item.maintenance).toEqual([]); expect(item.revisions[0].content.segments[0].text).toContain('negative');
    expect(executor.configuredKnowledgeGenerationModel).not.toHaveBeenCalled(); expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe('{invalid');
  });
});
