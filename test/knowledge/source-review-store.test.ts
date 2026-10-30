import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSourceCoverageStore, FileSourceLedgerStore, sourceReviewRevisionDigest } from '../../src/knowledge/adapters/source-review-store.js';
import { selectSourceCoverageDecision, validateSourceCoverageData, validateSourceCoverageDecisionDispositions, validateSourceLedgerData } from '../../src/knowledge/source-review-history.js';
import { bodyAt } from './body-fixtures.js';
import { reviewActor, reviewId, sourceReviewFixture } from './source-review-fixtures.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'omk-source-review-')); roots.push(root);
  const ledgers = new FileSourceLedgerStore(join(root, 'source-ledgers'), 'test', root), coverageStore = new FileSourceCoverageStore(join(root, 'source-coverage'), 'test', root);
  const f = sourceReviewFixture();
  const ledgerFile = () => join(root, 'source-ledgers', readdirSync(join(root, 'source-ledgers')).find(name => name.endsWith('.json'))!);
  const coverageFile = () => join(root, 'source-coverage', readdirSync(join(root, 'source-coverage')).find(name => name.endsWith('.json'))!);
  return { ...f, root, ledgers, coverageStore, ledgerFile, coverageFile };
}
describe('file source review histories', () => {
  it('reads absent histories without writing, publishes only after locked reference validation, and preserves exact retry bytes', () => {
    const f = fixture(); expect(f.ledgers.read(f.ledgerRef.ledgerId)).toBeUndefined(); expect(f.coverageStore.read(f.coverageRef.coverageId)).toBeUndefined();
    expect(readdirSync(f.root)).toEqual([]);
    const validate = vi.fn(() => { expect(existsSync(join(f.root, '.knowledge-write.lock'))).toBe(true); validateSourceLedgerData(f.ledgerData); });
    const receipt = f.ledgers.write(f.ledgerCommand, reviewActor, bodyAt, validate), bytes = readFileSync(f.ledgerFile());
    expect(validate).toHaveBeenCalledOnce(); expect(receipt.committedGeneration).toBe(1);
    expect(f.ledgers.read(f.ledgerRef.ledgerId)?.events[0]).toMatchObject({ actor: reviewActor, revision: f.ledger });
    expect(f.ledgers.write(f.ledgerCommand, reviewActor, bodyAt, () => { throw new Error('An exact retry must not reconstruct the model result.'); })).toEqual(receipt);
    expect(readFileSync(f.ledgerFile())).toEqual(bytes);
    expect(() => f.ledgers.write(f.ledgerCommand, { actorKind: 'human', actorId: 'other-actor' }, bodyAt, () => {})).toThrow('idempotency conflict');
    expect(() => f.ledgers.write({ ...f.ledgerCommand, requestId: reviewId(40) }, reviewActor, bodyAt, () => {})).toThrow('revision conflict');
    expect(readFileSync(f.ledgerFile())).toEqual(bytes); expect(existsSync(join(f.root, '.knowledge-write.lock'))).toBe(false);
    const next = structuredClone(f.ledgerCommand); next.requestId = reviewId(41); next.expectedGeneration = 1; next.expectedHeadEventId = f.ledgerCommand.requestId;
    next.revision.revisionId = reviewId(42); next.revision.parentRevisionId = f.ledger.revisionId; next.revision.data.limitations.push('New independent opinion, old evidence retained.');
    const { digest: previousDigest, ...content } = next.revision; void previousDigest; next.revision.digest = sourceReviewRevisionDigest(content);
    f.ledgers.write(next, reviewActor, bodyAt, () => validateSourceLedgerData(next.revision.data));
    const updated = new FileSourceLedgerStore(join(f.root, 'source-ledgers'), 'test', f.root).read(f.ledgerRef.ledgerId)!;
    expect(updated.events).toHaveLength(2); expect(updated.events[0]).toEqual(JSON.parse(bytes.toString()).events[0]); expect(updated.events[1].revision.parentRevisionId).toBe(f.ledger.revisionId);
    const appendedBytes = readFileSync(f.ledgerFile());
    expect(f.ledgers.write(f.ledgerCommand, reviewActor, bodyAt, () => {})).toEqual(receipt); expect(readFileSync(f.ledgerFile())).toEqual(appendedBytes);
  });
  it('keeps failed custody checks invisible and separates model analysis from an exact actual decision', () => {
    const f = fixture();
    expect(() => f.ledgers.write(f.ledgerCommand, reviewActor, bodyAt, () => { throw new Error('Source disappeared.'); })).toThrow('Source disappeared');
    expect(f.ledgers.read(f.ledgerRef.ledgerId)).toBeUndefined(); expect(existsSync(join(f.root, '.knowledge-write.lock'))).toBe(false);
    f.ledgers.write(f.ledgerCommand, reviewActor, bodyAt, () => validateSourceLedgerData(f.ledgerData));
    f.coverageStore.write(f.coverageCommand, reviewActor, bodyAt, () => validateSourceCoverageData(f.coverageData, f.ledger, [f.body]));
    expect(selectSourceCoverageDecision(f.coverageStore.read(f.coverageRef.coverageId), f.coverageRef).status).toBe('not_reviewed');
    const before = readFileSync(f.coverageFile()), missing = f.decision(); missing.decision.dispositions.pop();
    expect(() => f.coverageStore.write(missing, reviewActor, bodyAt, () => validateSourceCoverageDecisionDispositions(missing, f.coverage, f.ledger))).toThrow('unresolved dispositions');
    expect(readFileSync(f.coverageFile())).toEqual(before);
    const command = f.decision(); const receipt = f.coverageStore.write(command, reviewActor, bodyAt, () => validateSourceCoverageDecisionDispositions(command, f.coverage, f.ledger));
    const bytes = readFileSync(f.coverageFile()); expect(receipt.committedGeneration).toBe(2);
    expect(f.coverageStore.write(command, reviewActor, bodyAt, () => {})).toEqual(receipt); expect(readFileSync(f.coverageFile())).toEqual(bytes);
    expect(selectSourceCoverageDecision(f.coverageStore.read(f.coverageRef.coverageId), f.coverageRef).status).toBe('proceed_with_limits');
    expect(f.coverageStore.read(f.coverageRef.coverageId)?.events).toHaveLength(2);
  });
  it('rejects unauthored actors, wrong revision digests, corrupt receipts and unsupported history versions', () => {
    const f = fixture();
    expect(() => f.ledgers.write(f.ledgerCommand, undefined!, bodyAt, () => {})).toThrow();
    const wrong = structuredClone(f.ledgerCommand); wrong.revision.data.limitations.push('Mutation without a new digest.');
    expect(() => f.ledgers.write(wrong, reviewActor, bodyAt, () => {})).toThrow('digest mismatch');
    const wrongActor = structuredClone(f.ledgerCommand); wrongActor.revision.revisedBy = { actorKind: 'human', actorId: 'forged-author' };
    const { digest: oldDigest, ...content } = wrongActor.revision; void oldDigest;
    wrongActor.revision.digest = sourceReviewRevisionDigest(content);
    expect(() => f.ledgers.write(wrongActor, reviewActor, bodyAt, () => {})).toThrow('analysis history');
    f.ledgers.write(f.ledgerCommand, reviewActor, bodyAt, () => {});
    const original = readFileSync(f.ledgerFile(), 'utf8'), raw = JSON.parse(original); raw.receipts[0].commandDigest = `sha256:${'0'.repeat(64)}`;
    writeFileSync(f.ledgerFile(), JSON.stringify(raw)); expect(() => f.ledgers.read(f.ledgerRef.ledgerId)).toThrow('receipt integrity');
    writeFileSync(f.ledgerFile(), original); raw.schemaVersion = 2; writeFileSync(f.ledgerFile(), JSON.stringify(raw));
    expect(() => f.ledgers.read(f.ledgerRef.ledgerId)).toThrow('knowledge_storage_unsupported');
  });
  it('rejects redirected directories/files and shares the workspace writer lock', () => {
    const f = fixture(), other = mkdtempSync(join(tmpdir(), 'omk-source-review-outside-')); roots.push(other);
    symlinkSync(other, join(f.root, 'source-ledgers'));
    expect(() => f.ledgers.read(f.ledgerRef.ledgerId)).toThrow('directory');
    expect(() => f.ledgers.write(f.ledgerCommand, reviewActor, bodyAt, () => {})).toThrow('directory');
    rmSync(join(f.root, 'source-ledgers')); symlinkSync(join(other, 'missing'), join(f.root, 'source-ledgers'));
    expect(() => f.ledgers.read(f.ledgerRef.ledgerId)).toThrow('directory');
    rmSync(join(f.root, 'source-ledgers')); f.ledgers.write(f.ledgerCommand, reviewActor, bodyAt, () => {});
    const file = f.ledgerFile(), bytes = readFileSync(file); writeFileSync(join(other, 'history.json'), bytes); rmSync(file); symlinkSync(join(other, 'history.json'), file);
    expect(() => f.ledgers.read(f.ledgerRef.ledgerId)).toThrow('history file');
    const c = fixture();
    c.ledgers.write(c.ledgerCommand, reviewActor, bodyAt, () => {
      expect(() => c.coverageStore.write(c.coverageCommand, reviewActor, bodyAt, () => {})).toThrow('knowledge_workspace_busy');
    });
    expect(c.coverageStore.read(c.coverageRef.coverageId)).toBeUndefined(); expect(existsSync(join(c.root, '.knowledge-write.lock'))).toBe(false);
  });
});
