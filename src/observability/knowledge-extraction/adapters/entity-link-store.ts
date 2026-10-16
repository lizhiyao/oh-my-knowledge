import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EntityLinkReviewSchema, validateEntityLinkReview, type EntityLinkReview, type EntityLinkStore, type EntityLinkTransaction } from '../../../knowledge/entities/links.js';
import { createJsonFileAtomic, writeJsonFileAtomic } from '../../../shared/atomic-json.js';
import { checkStorageDirectory, KnowledgeStorageStateError } from '../../../evidence/storage/knowledge-workspace.js';
import { entityLinkDigest } from '../entity-link-hash.js';
import { FileLibraryStore } from './library-store.js';

const MAX_BYTES = 4 * 1024 * 1024;
// A pending intent must retain room for its bounded terminal event, even as other reviews arrive.
const allocation = (review: EntityLinkReview) => {
  const last = review.events.at(-1);
  return Buffer.byteLength(JSON.stringify(review, null, 2)) + (last?.eventKind === 'reviewed' && last.applicationIntent ? 4096 : 0);
};
/** A corrupt review can own a decision; never turn it into an apparently unreviewed pair. */
export class FileEntityLinkStore implements EntityLinkStore {
  private readonly root: string;
  private readonly library: FileLibraryStore;
  constructor(root: string, private readonly workspaceRoot: string) {
    if (!root.trim() || !workspaceRoot.trim()) throw new Error('Explicit entity-link workspace required.');
    this.root = resolve(root); this.library = new FileLibraryStore(join(workspaceRoot, 'library'), workspaceRoot);
  }
  private path(reviewId: string) { return join(this.root, `${EntityLinkReviewSchema.shape.capture.shape.reviewId.parse(reviewId)}.json`); }
  private checkRoot() { checkStorageDirectory(this.workspaceRoot); checkStorageDirectory(this.root); }
  read(reviewId: string): EntityLinkReview {
    this.checkRoot(); const path = this.path(reviewId); const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid entity-link file.');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || raw.storeKind !== 'entity-link-review-history' || raw.schemaVersion !== 1) throw new KnowledgeStorageStateError('knowledge_storage_unsupported');
    const review = validateEntityLinkReview(raw, entityLinkDigest);
    if (review.capture.reviewId !== reviewId) throw new Error('Entity-link file identity conflict.');
    return review;
  }
  list(): EntityLinkReview[] {
    this.checkRoot(); if (!existsSync(this.root)) return [];
    const names = readdirSync(this.root).filter(name => name.endsWith('.json')).sort();
    if (names.length > 4096) throw new Error('Entity-link capacity exceeded.');
    let bytes = 0;
    return names.map(name => {
      bytes += lstatSync(join(this.root, name)).size;
      if (bytes > 64 * 1024 * 1024) throw new Error('Entity-link capacity exceeded.');
      return this.read(name.slice(0, -5));
    });
  }
  private checkCapacity(next: EntityLinkReview, existing?: EntityLinkReview) {
    validateEntityLinkReview(next, entityLinkDigest);
    const bytes = allocation(next); const all = this.list();
    if (bytes > MAX_BYTES || (!existing && all.length >= 4096)
      || all.reduce((sum, review) => sum + allocation(review), 0)
        - (existing ? allocation(existing) : 0) + bytes > 64 * 1024 * 1024) throw new Error('Entity-link capacity exceeded.');
  }
  transaction<T>(operation: (transaction: EntityLinkTransaction) => T): T {
    return this.library.transaction(library => {
      let active = true;
      const assertActive = () => { if (!active) throw new Error('Entity-link transaction expired.'); this.checkRoot(); };
      try {
        return operation({ library, list: () => this.list(), read: id => this.read(id),
          create: review => { assertActive(); this.checkCapacity(review); createJsonFileAtomic(this.path(review.capture.reviewId), review); },
          append: (reviewId, expectedGeneration, events) => {
            assertActive(); const previous = this.read(reviewId);
            if (previous.generation !== expectedGeneration || !events.length) throw new Error('Entity-link revision conflict.');
            const next = { ...previous, events: [...previous.events, ...events], generation: previous.generation + events.length, writeHeadEventId: events.at(-1)!.eventId };
            this.checkCapacity(next, previous); writeJsonFileAtomic(this.path(reviewId), next); return next;
          },
        });
      } finally { active = false; }
    });
  }
}
