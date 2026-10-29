import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KnowledgeStorageStateError, withWorkspaceFileWrite } from '../../evidence/storage/knowledge-workspace.js';
import { type KnowledgeActor } from '../contracts.js';
import { canonicalJson } from '../store.js';
import { KnowledgeReviewActorSchema, KnowledgeReviewEnvelopeSchema, KnowledgeReviewWriteSchema, type KnowledgeReviewEnvelope, type KnowledgeReviewStore, type KnowledgeReviewWrite } from '../reviews.js';
import { applyKnowledgeReviewWrite, validateKnowledgeReviewHistory } from '../review-history.js';
import { confirmKnowledgePublication, publishKnowledgeBytes } from './durable-publication.js';

const MAX_BYTES = 16 * 1024 * 1024;
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
/** lstat distinguishes a truly absent directory from a dangling redirect. */
function checkReviewDirectory(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid knowledge review directory.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export class FileKnowledgeReviewStore implements KnowledgeReviewStore {
  private readonly root: string;
  constructor(root: string, private readonly namespace: string, private readonly workspaceRoot: string) {
    if (!root.trim() || !namespace.trim() || !workspaceRoot.trim()) throw new Error('Explicit review workspace and namespace required.');
    this.root = resolve(root);
  }
  private path(knowledgeId: string) {
    const id = KnowledgeReviewEnvelopeSchema.shape.knowledgeId.parse(knowledgeId);
    return join(this.root, `${digest([this.namespace, id]).slice(7)}.json`);
  }
  read(knowledgeId: string): KnowledgeReviewEnvelope | undefined {
    checkReviewDirectory(this.workspaceRoot); checkReviewDirectory(this.root);
    const path = this.path(knowledgeId);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid knowledge review file.');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (raw?.schemaVersion !== 1) throw new KnowledgeStorageStateError('knowledge_storage_unsupported');
    const history = KnowledgeReviewEnvelopeSchema.parse(raw);
    if (history.namespace !== this.namespace || history.knowledgeId !== knowledgeId) throw new Error('Knowledge review file identity mismatch.');
    validateKnowledgeReviewHistory(history);
    for (const [index, event] of history.events.entries()) {
      const { eventId, parentEventId, actor, at, ...decision } = event; void at;
      const command = KnowledgeReviewWriteSchema.parse({ ...decision, requestId: eventId, expectedGeneration: index, expectedHeadEventId: parentEventId });
      if (history.receipts[index].commandDigest !== digest({ namespace: this.namespace, actor, command })) throw new Error('Knowledge review receipt integrity mismatch.');
    }
    return history;
  }
  write(input: KnowledgeReviewWrite, actorInput: KnowledgeActor, at: string, validate: () => void) {
    const command = KnowledgeReviewWriteSchema.parse(input), actor = KnowledgeReviewActorSchema.parse(actorInput);
    const commandDigest = digest({ namespace: this.namespace, actor, command }), path = this.path(command.bodyRef.knowledgeId);
    checkReviewDirectory(this.workspaceRoot); checkReviewDirectory(this.root);
    return withWorkspaceFileWrite(this.workspaceRoot, path, () => {
      const existing = this.read(command.bodyRef.knowledgeId);
      const next = applyKnowledgeReviewWrite(existing, command, actor, this.namespace, commandDigest, at);
      if (next === existing) confirmKnowledgePublication(path, this.workspaceRoot);
      else {
        validate();
        const bytes = JSON.stringify(next, null, 2);
        if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Knowledge review capacity exceeded.');
        publishKnowledgeBytes(path, bytes, this.workspaceRoot, !existing);
      }
      return next.receipts.find(receipt => receipt.requestId === command.requestId)!;
    });
  }
}
