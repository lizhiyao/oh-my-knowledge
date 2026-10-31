import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KnowledgeStorageStateError, withWorkspaceFileWrite } from '../../evidence/storage/knowledge-workspace.js';
import type { KnowledgeActor } from '../contracts.js';
import { canonicalJson } from '../store.js';
import { KnowledgeReviewActorSchema } from '../reviews.js';
import { KnowledgeRelationEnvelopeSchema, KnowledgeRelationWriteSchema, type KnowledgeRelationEnvelope,
  type KnowledgeRelationInventory, type KnowledgeRelationStore, type KnowledgeRelationWrite } from '../relations.js';
import { applyKnowledgeRelationWrite, validateKnowledgeRelationHistory } from '../relation-history.js';
import { confirmKnowledgePublication, publishKnowledgeBytes } from './durable-publication.js';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_INVENTORY_BYTES = 64 * 1024 * 1024;
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
function checkDirectory(path: string): void {
  try { const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Invalid knowledge relation directory.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export class FileKnowledgeRelationStore implements KnowledgeRelationStore {
  private readonly root: string;
  constructor(root: string, private readonly namespace: string, private readonly workspaceRoot: string) {
    if (!root.trim() || !namespace.trim() || !workspaceRoot.trim()) throw new Error('Explicit relation workspace and namespace required.');
    this.root = resolve(root);
    if (this.root !== join(resolve(workspaceRoot), 'knowledge-relations')) throw new Error('Relations must use the workspace knowledge-relations directory.');
  }
  private path(id: string): string { return join(this.root, `${KnowledgeRelationEnvelopeSchema.shape.relationId.parse(id)}.json`); }
  read(relationId: string): KnowledgeRelationEnvelope | undefined {
    checkDirectory(this.workspaceRoot); checkDirectory(this.root);
    const path = this.path(relationId); let before;
    try { before = lstatSync(path, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_BYTES)) throw new Error('Invalid knowledge relation file.');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('Knowledge relation file changed.');
      const bounded = Buffer.allocUnsafe(Number(before.size) + 1); let offset = 0;
      while (offset < bounded.length) { const count = readSync(fd, bounded, offset, bounded.length - offset, offset); if (!count) break; offset += count; }
      bytes = bounded.subarray(0, offset);
      for (const current of [fstatSync(fd, { bigint: true }), lstatSync(path, { bigint: true })]) {
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size
          || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs || bytes.length !== Number(before.size)) throw new Error('Knowledge relation file changed.');
      }
    } finally { closeSync(fd); }
    const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (raw?.schemaVersion !== 1) throw new KnowledgeStorageStateError('knowledge_storage_unsupported');
    const history = KnowledgeRelationEnvelopeSchema.parse(raw);
    if (history.relationId !== relationId || history.namespace !== this.namespace) throw new Error('Knowledge relation file identity mismatch.');
    validateKnowledgeRelationHistory(history);
    for (const [index, event] of history.events.entries()) {
      const { eventId, parentEventId, actor, at, ...decision } = event; void at;
      const command = KnowledgeRelationWriteSchema.parse({ ...decision, relationId, requestId: eventId, expectedGeneration: index, expectedHeadEventId: parentEventId });
      if (history.receipts[index].commandDigest !== digest({ namespace: this.namespace, command, actor })) throw new Error('Knowledge relation receipt integrity mismatch.');
    }
    return history;
  }
  inventory(knowledgeIds?: ReadonlySet<string>): KnowledgeRelationInventory {
    const result: KnowledgeRelationInventory = { histories: [], unavailable: [], completeness: 'complete' };
    if (knowledgeIds?.size === 0) return result;
    let files: string[];
    try { checkDirectory(this.workspaceRoot); checkDirectory(this.root); files = readdirSync(this.root).filter(name => name.endsWith('.json')).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { result.unavailable.push({ reason: 'invalid_entry' }); result.completeness = 'partial'; }
      return result;
    }
    let bytes = 0;
    for (const [index, file] of files.entries()) {
      if (index >= 4096) { result.unavailable.push({ reason: 'capacity' }); break; }
      const parsed = KnowledgeRelationEnvelopeSchema.shape.relationId.safeParse(file.slice(0, -5));
      if (!parsed.success) { result.unavailable.push({ reason: 'invalid_entry' }); continue; }
      try {
        bytes += lstatSync(join(this.root, file)).size;
        if (bytes > MAX_INVENTORY_BYTES) { result.unavailable.push({ reason: 'capacity' }); break; }
        const history = this.read(parsed.data);
        if (!history) { result.unavailable.push({ relationId: parsed.data, reason: 'corrupt' }); continue; }
        const first = history.events[0];
        if (!knowledgeIds || first.eventKind === 'relation_proposed' && (knowledgeIds.has(first.from.bodyRef.knowledgeId) || knowledgeIds.has(first.to.bodyRef.knowledgeId))) result.histories.push(history);
      } catch (error) { result.unavailable.push({ relationId: parsed.data, reason: error instanceof KnowledgeStorageStateError ? 'unsupported' : 'corrupt' }); }
    }
    if (result.unavailable.length) result.completeness = 'partial';
    return result;
  }
  write(input: KnowledgeRelationWrite, actorInput: KnowledgeActor, at: string, validate: () => void) {
    const command = KnowledgeRelationWriteSchema.parse(input), actor = KnowledgeReviewActorSchema.parse(actorInput);
    const commandDigest = digest({ namespace: this.namespace, command, actor }), path = this.path(command.relationId);
    checkDirectory(this.workspaceRoot); checkDirectory(this.root);
    return withWorkspaceFileWrite(this.workspaceRoot, path, () => {
      const existing = this.read(command.relationId);
      const next = applyKnowledgeRelationWrite(existing, command, actor, this.namespace, commandDigest, at);
      if (next === existing) confirmKnowledgePublication(path, this.workspaceRoot);
      else {
        validate();
        const bytes = JSON.stringify(next, null, 2);
        if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Knowledge relation capacity exceeded.');
        publishKnowledgeBytes(path, bytes, this.workspaceRoot, !existing);
      }
      return next.receipts.find(receipt => receipt.requestId === command.requestId)!;
    });
  }
}
