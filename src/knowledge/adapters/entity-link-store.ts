import { existsSync, lstatSync, readFileSync, readdirSync, mkdirSync, writeFileSync, linkSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { EntityLinkWriteCapacityError, type EntityLinkInvocation, type EntityLinkInvocationStore, type EntityLinkInvocationTransaction } from '../entities/link-invocation.js';
import { validateEntityLinkInvocation, projectEntityLinkInvocation } from '../entities/link-invocation-state.js';
import { canonicalJson } from '../store.js';
import { checkStorageDirectory, KnowledgeStorageStateError } from '../../evidence/storage/knowledge-workspace.js';
import { entityLinkDigest } from '../linking/entity-link-hash.js';
import { createHash } from 'node:crypto';
import { FileLibraryStore } from './library-store.js';

const integrity = { hashJson: entityLinkDigest, hashText: (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}` };
/** Product storage quota, not a claim about the executor's output bound. */
export const ENTITY_LINK_NAMESPACE_BYTES = 512 * 1024 * 1024;
export const ENTITY_LINK_FILE_BYTES = ENTITY_LINK_NAMESPACE_BYTES;
const size = (value: unknown) => Buffer.byteLength(canonicalJson(value));
const uuid = 'ffffffff-ffff-4fff-bfff-ffffffffffff', sha = `sha256:${'f'.repeat(64)}`;
const text = '\0'.repeat(4096), actor = { actorKind: 'human', actorId: '\0'.repeat(256), executionRef: '\0'.repeat(256) };
const member = { analysisId: uuid, entityId: uuid, entityRevisionId: uuid, mentionIds: Array(64).fill(uuid), rationale: text };
// A conservative super-object containing every non-outcome event field. NUL attains
// the six-byte JSON expansion per allowed UTF-16 code unit. Host timestamps <=64.
const maximalEvent = { command: { reviewId: uuid, requestId: uuid, eventId: uuid, at: '\0'.repeat(64), actor,
  expectedGeneration: Number.MAX_SAFE_INTEGER, commandKind: 'cancel_before_start', executionId: uuid,
  owner: { ownerId: uuid, hostname: '\0'.repeat(256), pid: Number.MAX_SAFE_INTEGER }, decision: 'accept', reason: text,
  identityConfirmed: true, objectLabel: '\0'.repeat(256), application: { applicationKind: 'intent', intent: {
    requestId: uuid, objectId: uuid, expectedGeneration: Number.MAX_SAFE_INTEGER, expectedHeadRevisionId: uuid,
    revision: { revisionId: uuid, parentRevisionId: uuid, revisedAt: '\0'.repeat(64), revisedBy: actor, reason: text,
      draft: { label: '\0'.repeat(256), description: text, referentKind: 'collection', members: Array(256).fill(member) } } } },
  receipt: { requestId: uuid, commandDigest: sha, committedGeneration: Number.MAX_SAFE_INTEGER, revisionId: uuid }, conflictCode: 'pair_already_reviewed' },
  commandDigest: sha, eventDigest: sha, facts: { outcomeBytes: Number.MAX_SAFE_INTEGER, reservationStatus: 'overrun',
    admission: { admissionKind: 'admitted', suggestion: { responseKind: 'entity-link-suggestion', schemaVersion: 1,
      leftEntityId: uuid, rightEntityId: uuid, assessment: 'insufficient_evidence', leftMentionIds: Array(64).fill(uuid), rightMentionIds: Array(64).fill(uuid), rationale: text } },
    exit: { proofKind: 'local-process-exited', owner: { ownerId: uuid, hostname: '\0'.repeat(256), pid: Number.MAX_SAFE_INTEGER }, observedAt: '\0'.repeat(64) } } };
export const ENTITY_LINK_EVENT_RESERVE_BYTES = size(maximalEvent) + 1;
const terminal = new Set(['cancelled_before_start', 'rejected', 'accepted_conflict', 'applied']);
/** The original preparation owns all five future event slots before dispatch. */
export function entityLinkAllocation(history: EntityLinkInvocation): number {
  const status = projectEntityLinkInvocation(history, integrity).status;
  if (terminal.has(status)) return size(history);
  const first = history.events[0];
  const initial = { ...history, generation: 1, writeHeadEventId: first.command.eventId, events: [first] };
  const reservation = first.facts.reservation as { maxOutcomeJsonBytes: number };
  const preparedAllocation = size(initial) + reservation.maxOutcomeJsonBytes + 5 * ENTITY_LINK_EVENT_RESERVE_BYTES;
  const recorded = history.events.some(event => event.command.commandKind === 'execution_recorded');
  const remaining = status === 'accepted_pending_application' ? 1 : 2;
  const allocation = recorded ? size(history) + remaining * ENTITY_LINK_EVENT_RESERVE_BYTES : preparedAllocation;
  if (!Number.isSafeInteger(allocation) || size(history) > preparedAllocation) throw new EntityLinkWriteCapacityError('Entity-link reservation proof was exceeded.');
  return allocation;
}

/** Only the invocation v1 reader exists; corrupt files must never hide a pair decision. */
export class FileEntityLinkStore implements EntityLinkInvocationStore {
  private readonly root: string;
  private readonly library: FileLibraryStore;
  constructor(root: string, private readonly workspaceRoot: string) {
    if (!root.trim() || !workspaceRoot.trim()) throw new Error('Explicit entity-link workspace required.');
    this.root = resolve(root); this.library = new FileLibraryStore(join(workspaceRoot, 'library'), workspaceRoot);
  }
  private path(reviewId: string) { return join(this.root, `${z.string().uuid().parse(reviewId)}.json`); }
  private checkRoot() { checkStorageDirectory(this.workspaceRoot); checkStorageDirectory(this.root); }
  read(reviewId: string): EntityLinkInvocation {
    this.checkRoot(); const path = this.path(reviewId), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ENTITY_LINK_FILE_BYTES) throw new Error('Invalid entity-link file.');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || raw.storeKind !== 'entity-link-invocation-history' || raw.schemaVersion !== 1) throw new KnowledgeStorageStateError('knowledge_storage_unsupported');
    const history = validateEntityLinkInvocation(raw, integrity);
    if (history.reviewId !== reviewId) throw new Error('Entity-link file identity conflict.');
    return history;
  }
  list(): EntityLinkInvocation[] {
    this.checkRoot(); if (!existsSync(this.root)) return [];
    const names = readdirSync(this.root).filter(name => name.endsWith('.json')).sort();
    if (names.length > 4096) throw new Error('Entity-link capacity exceeded.');
    let bytes = 0;
    return names.map(name => {
      bytes += lstatSync(join(this.root, name)).size;
      if (bytes > ENTITY_LINK_NAMESPACE_BYTES) throw new Error('Entity-link capacity exceeded.');
      return this.read(name.slice(0, -5));
    });
  }
  private publish(next: EntityLinkInvocation, expectedGeneration: number): EntityLinkInvocation {
    validateEntityLinkInvocation(next, integrity); const all = this.list(), existing = all.find(value => value.reviewId === next.reviewId);
    // A lost acknowledgement is checked before quota or generation guards.
    if (existing && canonicalJson(existing) === canonicalJson(next)) return existing;
    if ((existing?.generation ?? 0) !== expectedGeneration || (existing && (next.generation <= existing.generation
      || canonicalJson(next.events.slice(0, existing.events.length)) !== canonicalJson(existing.events)))) throw new Error('Entity-link revision conflict.');
    const bytes = size(next), allocation = entityLinkAllocation(next);
    if (bytes > ENTITY_LINK_FILE_BYTES || allocation > ENTITY_LINK_FILE_BYTES || (!existing && all.length >= 4096)
      || all.reduce((sum, item) => sum + entityLinkAllocation(item), 0) - (existing ? entityLinkAllocation(existing) : 0) + allocation > ENTITY_LINK_NAMESPACE_BYTES) {
      throw new EntityLinkWriteCapacityError('Entity-link capacity exceeded before publication.');
    }
    const path = this.path(next.reviewId); mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, canonicalJson(next)); if (existing) renameSync(temp, path); else linkSync(temp, path); }
    finally { if (existsSync(temp)) rmSync(temp, { force: true }); }
    return next;
  }
  transaction<T>(operation: (transaction: EntityLinkInvocationTransaction) => T): T {
    return this.library.transaction(library => {
      let active = true;
      const assertActive = () => { if (!active) throw new Error('Entity-link transaction expired.'); this.checkRoot(); };
      try { return operation({ library, list: () => { assertActive(); return this.list(); }, read: id => { assertActive(); return this.read(id); },
        save: (history, generation) => { assertActive(); return this.publish(history, generation); } }); }
      finally { active = false; }
    });
  }
}
