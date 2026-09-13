import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeJsonFileAtomic } from '../../../shared/atomic-json.js';
import { withFileLock } from '../../../shared/file-lock.js';
import { KnowledgeActorSchema, type KnowledgeActor } from '../../../knowledge/contracts.js';
import { applyKnowledgeWrite, validateKnowledgeHistory } from '../../../knowledge/history.js';
import {
  canonicalJson, KnowledgeEnvelopeSchema, type KnowledgeEnvelope, type KnowledgeStore, type KnowledgeWrite,
} from '../../../knowledge/store.js';

const MAX_BYTES = 16 * 1024 * 1024;
const digest = (value: unknown): string => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

/** Adapter roots and actor identity come from trusted host composition, not request payloads. */
export class FileKnowledgeStore implements KnowledgeStore {
  private readonly root: string;
  constructor(root: string, private readonly namespace: string) {
    if (!root.trim() || !namespace.trim()) throw new Error('Explicit knowledge root and namespace required.');
    this.root = resolve(root);
  }
  private path(knowledgeId: string): string {
    return join(this.root, `${digest([this.namespace, knowledgeId]).slice(7)}.json`);
  }
  list(): KnowledgeEnvelope[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter((name) => name.endsWith('.json')).sort().map((name) => {
      const entry = this.load(join(this.root, name));
      if (this.path(entry.knowledgeId) !== join(this.root, name)) throw new Error('Knowledge filename identity mismatch.');
      return entry;
    });
  }
  read(knowledgeId: string): KnowledgeEnvelope {
    const entry = this.load(this.path(knowledgeId));
    if (entry.knowledgeId !== knowledgeId) throw new Error('Knowledge identity mismatch.');
    return entry;
  }
  private load(path: string): KnowledgeEnvelope {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid knowledge file.');
    const entry = KnowledgeEnvelopeSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (entry.namespace !== this.namespace) throw new Error('Knowledge namespace mismatch.');
    validateKnowledgeHistory(entry);
    return entry;
  }
  write(command: KnowledgeWrite, actorInput: KnowledgeActor): KnowledgeEnvelope['receipts'][number] {
    const actor = KnowledgeActorSchema.parse(actorInput);
    // Reject non-JSON input before hashing; retries retain their original payload timestamps.
    const commandDigest = digest({ namespace: this.namespace, actor: { actorKind: actor.actorKind, actorId: actor.actorId }, command });
    if (!command.requestId.trim() || !Number.isSafeInteger(command.expectedGeneration) || command.expectedGeneration < 0) throw new Error('Invalid write request.');
    const path = this.path(command.knowledgeId);
    return withFileLock(`${path}.lock`, () => {
      const existing = existsSync(path) ? this.read(command.knowledgeId) : undefined;
      const next = applyKnowledgeWrite(existing, command, actor, this.namespace, commandDigest);
      if (next === existing) return next.receipts.find((item) => item.requestId === command.requestId)!;
      if (Buffer.byteLength(JSON.stringify(next, null, 2)) > MAX_BYTES) throw new Error('capacity_exceeded');
      writeJsonFileAtomic(path, next);
      return next.receipts.at(-1)!;
    }, { recoverStale: false });
  }
}
