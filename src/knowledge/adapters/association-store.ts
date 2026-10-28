import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkStorageDirectory, withWorkspaceFileWrite } from '../../evidence/storage/knowledge-workspace.js';
import { KnowledgeActorSchema, type KnowledgeActor } from '../contracts.js';
import type { EntityAnalysisStore } from '../entities/contracts.js';
import { canonicalJson, type KnowledgeStore } from '../store.js';
import { applyKnowledgeAssociationWrite, KnowledgeAssociationEnvelopeSchema, KnowledgeAssociationWriteSchema, validateKnowledgeAssociationHistory, validateKnowledgeAssociationReferences,
  type KnowledgeAssociationEnvelope, type KnowledgeAssociationStore, type KnowledgeAssociationWrite } from '../associations.js';
import { confirmKnowledgePublication, publishKnowledgeBytes } from './durable-publication.js';

const MAX_BYTES = 16 * 1024 * 1024;
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
export class FileKnowledgeAssociationStore implements KnowledgeAssociationStore {
  private readonly root: string;
  constructor(root: string, private readonly namespace: string, private readonly knowledge: KnowledgeStore,
    private readonly entities: EntityAnalysisStore, private readonly workspaceRoot = root) {
    if (!root.trim() || !namespace.trim()) throw new Error('Explicit association root and namespace required.');
    this.root = resolve(root);
  }
  private path(id: string) { return join(this.root, `${digest([this.namespace, id]).slice(7)}.json`); }
  list(): KnowledgeAssociationEnvelope[] {
    checkStorageDirectory(this.workspaceRoot); checkStorageDirectory(this.root);
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter(name => name.endsWith('.json')).sort().map(name => {
      const entry = this.load(join(this.root, name));
      if (this.path(entry.knowledgeId) !== join(this.root, name)) throw new Error('Association filename identity mismatch.');
      return entry;
    });
  }
  read(id: string): KnowledgeAssociationEnvelope {
    const entry = this.load(this.path(id));
    if (entry.knowledgeId !== id) throw new Error('Association knowledge identity mismatch.');
    return entry;
  }
  private validateReferences(entry: KnowledgeAssociationEnvelope) {
    const knowledge = this.knowledge.read(entry.knowledgeId);
    for (const revision of entry.revisions) {
      const body = knowledge.revisions.find(body => body.revisionId === revision.bodyRef.revisionId);
      if (!body) throw new Error('Unknown association body revision.');
      validateKnowledgeAssociationReferences(revision, body);
      if (!revision.entityAnalysisRef) continue;
      const analysis = this.entities.read(revision.entityAnalysisRef.analysisId);
      const catalog = analysis.revisions.find(item => item.revisionId === revision.entityAnalysisRef!.revisionId);
      if (!catalog) throw new Error('Unknown association entity revision.');
      for (const ref of revision.segmentEntityRefs) {
        const segment = body.content.segments.find(item => item.segmentId === ref.segmentId)!;
        if (!catalog.entities.some(entity => entity.entityId === ref.entityId)
          || !segment.evidence.some(evidence => evidence.source.snapshotId === analysis.snapshotId && evidence.source.sourceVersion === analysis.sourceVersion)
          || ref.mentionIds.some(id => !catalog.mentions.some(mention => mention.mentionId === id && mention.entityId === ref.entityId))) {
          throw new Error('Association entity catalog mismatch.');
        }
      }
    }
  }
  private load(path: string): KnowledgeAssociationEnvelope {
    checkStorageDirectory(this.workspaceRoot); checkStorageDirectory(this.root);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid association file.');
    const entry = KnowledgeAssociationEnvelopeSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (entry.namespace !== this.namespace) throw new Error('Association namespace mismatch.');
    validateKnowledgeAssociationHistory(entry); this.validateReferences(entry); return entry;
  }
  write(input: KnowledgeAssociationWrite, actorInput: KnowledgeActor): KnowledgeAssociationEnvelope['receipts'][number] {
    const actor = KnowledgeActorSchema.parse(actorInput);
    const command = KnowledgeAssociationWriteSchema.parse(input);
    if (!command.requestId.trim() || !Number.isSafeInteger(command.expectedGeneration) || command.expectedGeneration < 0) throw new Error('Invalid association request.');
    const commandDigest = digest({ namespace: this.namespace, actor, command }); const path = this.path(command.knowledgeId);
    checkStorageDirectory(this.root);
    return withWorkspaceFileWrite(this.workspaceRoot, path, () => {
      const existing = existsSync(path) ? this.read(command.knowledgeId) : undefined;
      const next = applyKnowledgeAssociationWrite(existing, command, actor, this.namespace, commandDigest);
      if (next === existing) confirmKnowledgePublication(path, this.workspaceRoot);
      else {
        this.validateReferences(next);
        const bytes = JSON.stringify(next, null, 2);
        if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('capacity_exceeded');
        publishKnowledgeBytes(path, bytes, this.workspaceRoot, !existing);
      }
      return next.receipts.find(receipt => receipt.requestId === command.requestId)!;
    });
  }
}
