import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { confirmKnowledgePublication, publishKnowledgeBytes } from './durable-publication.js';
import { knowledgeBodyRef, validateKnowledgeBodyDigests } from './body-digest.js';
import { KnowledgeActorSchema, KnowledgeBodyRefSchema, type KnowledgeActor, type KnowledgeBodyRef } from '../contracts.js';
import { applyKnowledgeWrite, validateKnowledgeHistory } from '../history.js';
import {
  canonicalJson, KnowledgeEnvelopeSchema, KnowledgeWriteSchema, type KnowledgeEnvelope, type KnowledgeStore, type KnowledgeWrite,
} from '../store.js';
import { checkStorageDirectory, withWorkspaceFileWrite, withWorkspaceWrite, type SourceMigrationWriteContext } from './workspace-guard.js';
import { assertCurrentStorage } from './storage-state.js';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_BYTES = 256 * 1024;
const batchPrefix = 'window-batch/';
const batchId = z.uuid();
const BatchPublicationSchema = z.strictObject({
  storeKind: z.literal('knowledge-window-batch-publication'), schemaVersion: z.literal(1),
  namespace: KnowledgeEnvelopeSchema.shape.namespace, runId: batchId, bodies: z.array(KnowledgeBodyRefSchema).max(256),
}).refine(value => new Set(value.bodies.map(body => body.knowledgeId)).size === value.bodies.length,
  'A knowledge batch must contain distinct bodies.');
type BatchPublication = z.infer<typeof BatchPublicationSchema>;
const digest = (value: unknown): string => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

function batchRun(actor: KnowledgeActor): string | undefined {
  if (actor.actorKind !== 'agent' || !actor.executionRef.startsWith(batchPrefix)) return;
  const ids = actor.executionRef.slice(batchPrefix.length).split('/');
  if (ids.length !== 2 || !ids.every(id => batchId.safeParse(id).success)) throw new Error('Invalid knowledge batch execution reference.');
  return ids[0];
}
function absent(): never {
  throw Object.assign(new Error('Knowledge history is not published.'), { code: 'ENOENT' });
}
function initialRef(entry: KnowledgeEnvelope) {
  return knowledgeBodyRef(entry.revisions[0]);
}
function includesBody(publication: BatchPublication | undefined, entry: KnowledgeEnvelope): boolean {
  return publication?.bodies.some(ref => same(ref, initialRef(entry))) ?? false;
}

/** Adapter roots and actor identity come from trusted host composition, not request payloads. */
export class FileKnowledgeStore implements KnowledgeStore {
  private readonly root: string;
  private readonly batches: string;
  constructor(root: string, private readonly namespace: string, private readonly workspaceRoot = root,
    private readonly migrationWriteContext?: SourceMigrationWriteContext) {
    if (!root.trim() || !namespace.trim()) throw new Error('Explicit knowledge root and namespace required.');
    this.root = resolve(root);
    this.batches = join(this.root, 'window-batches');
  }
  private path(knowledgeId: string): string {
    return join(this.root, `${digest([this.namespace, knowledgeId]).slice(7)}.json`);
  }
  private batchPath(runId: string): string {
    return join(this.batches, `${batchId.parse(runId)}.json`);
  }
  private loadBatch(runId: string): BatchPublication | undefined {
    checkStorageDirectory(this.batches);
    const path = this.batchPath(runId);
    let stat;
    try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BATCH_BYTES) throw new Error('Invalid knowledge batch publication file.');
    const result = BatchPublicationSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (result.runId !== runId || result.namespace !== this.namespace) throw new Error('Knowledge batch publication identity mismatch.');
    return result;
  }
  list(knowledgeIds?: ReadonlySet<string>): KnowledgeEnvelope[] {
    checkStorageDirectory(this.workspaceRoot); checkStorageDirectory(this.root);
    if (!existsSync(this.root)) return [];
    checkStorageDirectory(this.batches);
    // The marker snapshot precedes item enumeration. All files named by a marker were durable before it appeared.
    const published = new Map<string, BatchPublication>();
    const expected = new Set<string>();
    if (existsSync(this.batches)) for (const name of readdirSync(this.batches)) {
      if (!name.endsWith('.json')) continue;
      const runId = name.slice(0, -5), publication = this.loadBatch(runId);
      if (!publication) throw new Error('Knowledge batch publication disappeared during listing.');
      published.set(runId, publication);
      for (const ref of publication.bodies) {
        if (knowledgeIds && !knowledgeIds.has(ref.knowledgeId)) continue;
        if (expected.has(ref.knowledgeId)) throw new Error('A knowledge body belongs to multiple batch publications.');
        expected.add(ref.knowledgeId);
      }
    }
    const selected = knowledgeIds ? new Set([...knowledgeIds].map(id => this.path(id))) : undefined;
    const visible = readdirSync(this.root).filter((name) => name.endsWith('.json')).sort()
      .filter(name => !selected || selected.has(join(this.root, name))).flatMap(name => {
        const entry = this.load(join(this.root, name));
        if (this.path(entry.knowledgeId) !== join(this.root, name)) throw new Error('Knowledge filename identity mismatch.');
        const runId = batchRun(entry.revisions[0].createdBy);
        if (!runId) return [entry];
        if (!includesBody(published.get(runId), entry)) return [];
        expected.delete(entry.knowledgeId);
        return [entry];
      });
    if (expected.size) throw new Error('Incomplete knowledge batch publication.');
    return visible;
  }
  read(knowledgeId: string): KnowledgeEnvelope {
    const entry = this.loadEntry(knowledgeId);
    const runId = batchRun(entry.revisions[0].createdBy);
    if (runId && !includesBody(this.loadBatch(runId), entry)) absent();
    return entry;
  }
  private loadEntry(knowledgeId: string): KnowledgeEnvelope {
    const entry = this.load(this.path(knowledgeId));
    if (entry.knowledgeId !== knowledgeId) throw new Error('Knowledge identity mismatch.');
    return entry;
  }
  private load(path: string): KnowledgeEnvelope {
    checkStorageDirectory(this.workspaceRoot); checkStorageDirectory(this.root);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid knowledge file.');
    const raw = JSON.parse(readFileSync(path, 'utf8')); assertCurrentStorage(raw, 'knowledge');
    const entry = KnowledgeEnvelopeSchema.parse(raw);
    if (entry.namespace !== this.namespace) throw new Error('Knowledge namespace mismatch.');
    validateKnowledgeHistory(entry);
    validateKnowledgeBodyDigests(entry.revisions);
    return entry;
  }
  write(input: KnowledgeWrite, actorInput: KnowledgeActor): KnowledgeEnvelope['receipts'][number] {
    const actor = KnowledgeActorSchema.parse(actorInput);
    const command = KnowledgeWriteSchema.parse(input);
    const batch = batchRun(actor);
    // Reject non-JSON input before hashing; retries retain their original payload timestamps.
    const commandDigest = digest({ namespace: this.namespace, actor: { actorKind: actor.actorKind, actorId: actor.actorId }, command });
    if (!command.requestId.trim() || !Number.isSafeInteger(command.expectedGeneration) || command.expectedGeneration < 0) throw new Error('Invalid write request.');
    const path = this.path(command.knowledgeId);
    checkStorageDirectory(this.root);
    return withWorkspaceFileWrite(this.workspaceRoot, path, () => {
      const existing = existsSync(path) ? this.loadEntry(command.knowledgeId) : undefined;
      if (batch) {
        if (command.commandKind !== 'append_revision' || command.expectedGeneration !== 0) throw new Error('Knowledge batch writes must be initial revisions.');
        if (existing && (!same(existing.revisions[0].createdBy, actor) || existing.receipts[0].requestId !== command.requestId)) {
          throw new Error('Knowledge batch write conflicts with its staged history.');
        }
        const publication = this.loadBatch(batch);
        if (publication && (!existing || !includesBody(publication, existing))) throw new Error('Knowledge batch is already published.');
      } else if (existing) {
        const runId = batchRun(existing.revisions[0].createdBy);
        if (runId && !includesBody(this.loadBatch(runId), existing)) absent();
      }
      const next = applyKnowledgeWrite(existing, command, actor, this.namespace, commandDigest);
      if (next === existing) {
        confirmKnowledgePublication(path, this.workspaceRoot);
        return next.receipts.find((item) => item.requestId === command.requestId)!;
      }
      validateKnowledgeBodyDigests(next.revisions);
      if (Buffer.byteLength(JSON.stringify(next, null, 2)) > MAX_BYTES) throw new Error('capacity_exceeded');
      publishKnowledgeBytes(path, JSON.stringify(next, null, 2), this.workspaceRoot, !existing);
      return next.receipts.at(-1)!;
    }, this.migrationWriteContext);
  }
  commitBodyBatch(runId: string, bodies: readonly KnowledgeBodyRef[]): void {
    const publication = BatchPublicationSchema.parse({ storeKind: 'knowledge-window-batch-publication', schemaVersion: 1,
      namespace: this.namespace, runId, bodies });
    const path = this.batchPath(runId);
    const bytes = canonicalJson(publication);
    if (Buffer.byteLength(bytes) > MAX_BATCH_BYTES) throw new Error('capacity_exceeded');
    withWorkspaceWrite(this.workspaceRoot, () => {
      const existing = this.loadBatch(runId);
      if (existing && !same(existing, publication)) throw new Error('Knowledge batch publication conflict.');
      for (const ref of publication.bodies) {
        const entry = this.loadEntry(ref.knowledgeId);
        if (batchRun(entry.revisions[0].createdBy) !== runId || !same(initialRef(entry), ref)) throw new Error('Knowledge batch body identity mismatch.');
      }
      if (existing) confirmKnowledgePublication(path, this.workspaceRoot);
      else publishKnowledgeBytes(path, bytes, this.workspaceRoot, true);
    }, this.migrationWriteContext);
  }
}
