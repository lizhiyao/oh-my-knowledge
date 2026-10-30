import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KnowledgeStorageStateError, withWorkspaceFileWrite } from '../../evidence/storage/knowledge-workspace.js';
import type { KnowledgeActor } from '../contracts.js';
import { applySourceCoverageWrite, applySourceLedgerWrite, validateSourceCoverageHistory, validateSourceLedgerHistory } from '../source-review-history.js';
import { SourceCoverageEnvelopeSchema, SourceCoverageWriteSchema, SourceLedgerEnvelopeSchema, SourceLedgerWriteSchema, SourceReviewActorSchema,
  type SourceCoverageEnvelope, type SourceCoverageRevision, type SourceCoverageStore, type SourceCoverageWrite, type SourceLedgerEnvelope,
  type SourceLedgerRevision, type SourceLedgerStore, type SourceLedgerWrite, type SourceReviewReceipt } from '../source-review.js';
import { canonicalJson } from '../store.js';
import { confirmKnowledgePublication, publishKnowledgeBytes } from './durable-publication.js';

const MAX_BYTES = 16 * 1024 * 1024;
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
export function sourceReviewRevisionDigest(revision: Omit<SourceLedgerRevision | SourceCoverageRevision, 'digest'>): string { return digest(revision); }
function validateRevisionDigest(revision: SourceLedgerRevision | SourceCoverageRevision) {
  const { digest: actual, ...content } = revision;
  if (actual !== sourceReviewRevisionDigest(content)) throw new Error('Source review revision digest mismatch.');
}
type History = SourceLedgerEnvelope | SourceCoverageEnvelope;
type Command = SourceLedgerWrite | SourceCoverageWrite;
function commandForEvent(history: History, index: number): Command {
  const event = history.events[index];
  const identity = { requestId: event.eventId, expectedGeneration: index, expectedHeadEventId: event.parentEventId };
  if (history.storeKind === 'knowledge-source-ledger-history') {
    if (event.eventKind !== 'analysis') throw new Error('Invalid source ledger event.');
    return SourceLedgerWriteSchema.parse({ ...identity, ledgerId: history.ledgerId, commandKind: 'append_analysis', revision: event.revision });
  }
  return SourceCoverageWriteSchema.parse({ ...identity, coverageId: history.coverageId, ...(event.eventKind === 'analysis' ? { commandKind: 'append_analysis', revision: event.revision }
    : event.eventKind === 'decision' ? { commandKind: 'record_decision', decision: event.decision } : { commandKind: 'revoke_decision', targetEventId: event.targetEventId, reason: event.reason }) });
}
class SourceReviewFiles {
  readonly root: string;
  constructor(root: string, readonly namespace: string, readonly workspaceRoot: string) {
    if (!root.trim() || !namespace.trim() || !workspaceRoot.trim()) throw new Error('Explicit source review workspace and namespace required.');
    this.root = resolve(root);
  }
  path(id: string): string {
    SourceLedgerEnvelopeSchema.shape.ledgerId.parse(id);
    return join(this.root, `${digest([this.namespace, id]).slice(7)}.json`);
  }
  check() {
    for (const path of [this.workspaceRoot, this.root]) {
      try { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid source review directory.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  read(id: string, storeKind: History['storeKind']): History | undefined {
    this.check(); const path = this.path(id);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid source review history file.');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (raw?.schemaVersion !== 1) throw new KnowledgeStorageStateError('knowledge_storage_unsupported');
    const history = storeKind === 'knowledge-source-ledger-history' ? SourceLedgerEnvelopeSchema.parse(raw) : SourceCoverageEnvelopeSchema.parse(raw);
    if (history.namespace !== this.namespace || (history.storeKind === 'knowledge-source-ledger-history' ? history.ledgerId : history.coverageId) !== id) throw new Error('Source review file identity mismatch.');
    if (history.storeKind === 'knowledge-source-ledger-history') validateSourceLedgerHistory(history); else validateSourceCoverageHistory(history);
    for (const [index, event] of history.events.entries()) {
      if (event.eventKind === 'analysis') validateRevisionDigest(event.revision);
      const command = commandForEvent(history, index);
      if (history.receipts[index].commandDigest !== digest({ namespace: this.namespace, actor: event.actor, command })) throw new Error('Source review receipt integrity mismatch.');
    }
    return history;
  }
  publish(path: string, existing: History | undefined, next: History, validate: () => void) {
    if (next === existing) confirmKnowledgePublication(path, this.workspaceRoot);
    else {
      validate();
      const bytes = JSON.stringify(next, null, 2);
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Source review history capacity exceeded.');
      publishKnowledgeBytes(path, bytes, this.workspaceRoot, !existing);
    }
  }
}
/** All upstream references are revalidated by the application callback inside the shared workspace lock. */
export class FileSourceLedgerStore implements SourceLedgerStore {
  private readonly files: SourceReviewFiles;
  constructor(root: string, namespace: string, workspaceRoot: string) { this.files = new SourceReviewFiles(root, namespace, workspaceRoot); }
  read(id: string): SourceLedgerEnvelope | undefined { return this.files.read(id, 'knowledge-source-ledger-history') as SourceLedgerEnvelope | undefined; }
  write(input: SourceLedgerWrite, actorInput: KnowledgeActor, at: string, validate: () => void): SourceReviewReceipt {
    const command = SourceLedgerWriteSchema.parse(input), actor = SourceReviewActorSchema.parse(actorInput);
    validateRevisionDigest(command.revision);
    const commandDigest = digest({ namespace: this.files.namespace, actor, command }), path = this.files.path(command.ledgerId);
    this.files.check();
    return withWorkspaceFileWrite(this.files.workspaceRoot, path, () => {
      const existing = this.read(command.ledgerId), next = applySourceLedgerWrite(existing, command, actor, this.files.namespace, commandDigest, at);
      this.files.publish(path, existing, next, validate);
      return next.receipts.find(receipt => receipt.requestId === command.requestId)!;
    });
  }
}
export class FileSourceCoverageStore implements SourceCoverageStore {
  private readonly files: SourceReviewFiles;
  constructor(root: string, namespace: string, workspaceRoot: string) { this.files = new SourceReviewFiles(root, namespace, workspaceRoot); }
  read(id: string): SourceCoverageEnvelope | undefined { return this.files.read(id, 'knowledge-source-coverage-history') as SourceCoverageEnvelope | undefined; }
  write(input: SourceCoverageWrite, actorInput: KnowledgeActor, at: string, validate: () => void): SourceReviewReceipt {
    const command = SourceCoverageWriteSchema.parse(input), actor = SourceReviewActorSchema.parse(actorInput);
    if (command.commandKind === 'append_analysis') validateRevisionDigest(command.revision);
    const commandDigest = digest({ namespace: this.files.namespace, actor, command }), path = this.files.path(command.coverageId);
    this.files.check();
    return withWorkspaceFileWrite(this.files.workspaceRoot, path, () => {
      const existing = this.read(command.coverageId), next = applySourceCoverageWrite(existing, command, actor, this.files.namespace, commandDigest, at);
      this.files.publish(path, existing, next, validate);
      return next.receipts.find(receipt => receipt.requestId === command.requestId)!;
    });
  }
}
