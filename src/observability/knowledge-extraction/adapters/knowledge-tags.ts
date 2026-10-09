import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { KnowledgeActorSchema, type KnowledgeActor } from '../../../knowledge/contracts.js';
import { KnowledgeTagsSchema, type KnowledgeTagState, type KnowledgeTagStore } from '../../../knowledge/tags.js';
import { canonicalJson } from '../../../knowledge/store.js';
import { writeJsonFileAtomic } from '../../../shared/atomic-json.js';
import { withFileLock } from '../../../shared/file-lock.js';

const envelope = z.strictObject({
  schemaVersion: z.literal('omk-knowledge-tags/v1'), namespace: z.string().min(1), knowledgeId: z.string().min(1).max(256),
  revisions: z.array(z.strictObject({ tags: KnowledgeTagsSchema, updatedAt: z.iso.datetime({ offset: true }), updatedBy: KnowledgeActorSchema })).min(1).max(1024),
});

/** Additive organization records; existing knowledge/source/run documents are never rewritten. */
export class FileKnowledgeTags implements KnowledgeTagStore {
  private readonly root: string;
  constructor(root: string, private readonly namespace: string) {
    if (!root.trim() || !namespace.trim()) throw new Error('Explicit tag root and namespace required.');
    this.root = resolve(root);
  }
  private path(id: string) { return join(this.root, `${createHash('sha256').update(canonicalJson([this.namespace, id])).digest('hex')}.json`); }
  private load(id: string) {
    if (existsSync(this.root)) { const stat = lstatSync(this.root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid tag directory.'); }
    const path = this.path(id);
    if (!existsSync(path)) return undefined;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new Error('Invalid tag file.');
    const value = envelope.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (value.namespace !== this.namespace || value.knowledgeId !== id) throw new Error('Tag identity mismatch.');
    return value;
  }
  read(id: string): KnowledgeTagState { const value = this.load(id); return { generation: value?.revisions.length ?? 0, tags: value?.revisions.at(-1)?.tags ?? [] }; }
  write(id: string, generation: number, input: unknown, actor: KnowledgeActor): KnowledgeTagState {
    z.string().min(1).max(256).parse(id); z.number().int().nonnegative().parse(generation);
    const parsed = KnowledgeTagsSchema.safeParse(input);
    if (!parsed.success) throw new Error('Knowledge tags invalid.');
    const tags = parsed.data; const updatedBy = KnowledgeActorSchema.parse(actor);
    // Validate the organization directory before lock acquisition can create files in it.
    this.load(id);
    return withFileLock(`${this.path(id)}.lock`, () => {
      const previous = this.load(id);
      if ((previous?.revisions.length ?? 0) !== generation) throw new Error('Knowledge tag conflict.');
      if (JSON.stringify(previous?.revisions.at(-1)?.tags ?? []) === JSON.stringify(tags)) return { generation, tags };
      const next = envelope.parse({ schemaVersion: 'omk-knowledge-tags/v1', namespace: this.namespace, knowledgeId: id,
        revisions: [...(previous?.revisions ?? []), { tags, updatedAt: new Date().toISOString(), updatedBy }] });
      if (Buffer.byteLength(JSON.stringify(next)) > 512 * 1024) throw new Error('Tag capacity exceeded.');
      writeJsonFileAtomic(this.path(id), next);
      return { generation: next.revisions.length, tags };
    });
  }
}
