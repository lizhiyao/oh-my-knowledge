import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkStorageDirectory, KnowledgeStorageStateError, withWorkspaceFileWrite } from '../../evidence/storage/knowledge-workspace.js';
import { KnowledgeActorSchema, type KnowledgeActor } from '../contracts.js';
import type { EntityAnalysisStore } from '../entities/contracts.js';
import { canonicalJson, type KnowledgeStore } from '../store.js';
import { applyKnowledgeAssociationWrite, KnowledgeAssociationEnvelopeSchema, KnowledgeAssociationWriteSchema, validateKnowledgeAssociationHistory, validateKnowledgeAssociationReferences,
  type KnowledgeAssociationEnvelope, type KnowledgeAssociationStore, type KnowledgeAssociationWrite } from '../associations.js';
import { validateKnowledgeAssociationCatalogReferences } from '../entities/association-references.js';
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
    }
  }
  private validateCatalogs(entry: KnowledgeAssociationEnvelope, revisionId: string) {
    const revision = entry.revisions.find(value => value.revisionId === revisionId);
    if (!revision) throw new Error('Unknown association revision.');
    const body = this.knowledge.read(entry.knowledgeId).revisions.find(value => value.revisionId === revision.bodyRef.revisionId);
    if (!body) throw new Error('Unknown association body revision.');
    for (const ref of revision.catalogRefs) {
      validateKnowledgeAssociationCatalogReferences(revision, body, this.entities.read(ref.analysisId), ref.entityRevisionId);
    }
  }
  private load(path: string): KnowledgeAssociationEnvelope {
    checkStorageDirectory(this.workspaceRoot); checkStorageDirectory(this.root);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid association file.');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (raw?.schemaVersion !== 2) throw new KnowledgeStorageStateError('knowledge_storage_unsupported');
    const entry = KnowledgeAssociationEnvelopeSchema.parse(raw);
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
        if (command.commandKind === 'append_revision') this.validateCatalogs(next, command.revision.revisionId);
        else if (command.review.choice === 'accept') this.validateCatalogs(next, command.review.projectionRevisionId);
        const bytes = JSON.stringify(next, null, 2);
        if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('capacity_exceeded');
        publishKnowledgeBytes(path, bytes, this.workspaceRoot, !existing);
      }
      return next.receipts.find(receipt => receipt.requestId === command.requestId)!;
    });
  }
}
