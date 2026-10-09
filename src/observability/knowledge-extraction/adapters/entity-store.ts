import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KnowledgeActorSchema, type KnowledgeActor } from '../../../knowledge/contracts.js';
import { applyEntityAnalysisWrite, EntityAnalysisEnvelopeSchema, EntityAnalysisWriteSchema, validateEntityAnalysisHistory,
  type EntityAnalysisEnvelope, type EntityAnalysisStore, type EntityAnalysisWrite } from '../../../knowledge/entities.js';
import { canonicalJson } from '../../../knowledge/store.js';
import { writeJsonFileAtomic } from '../../../shared/atomic-json.js';
import { withFileLock } from '../../../shared/file-lock.js';
import { assertWorkspaceReady, recoverStorageLock, withWorkspaceWrite } from './storage-state.js';

const MAX_BYTES = 16 * 1024 * 1024;
export class FileEntityAnalysisStore implements EntityAnalysisStore {
  private readonly root: string;
  constructor(root: string, private readonly workspaceRoot = root) { if (!root.trim()) throw new Error('Explicit entity root required.'); this.root = resolve(root); }
  private path(id: string) { return join(this.root, `${EntityAnalysisWriteSchema.shape.analysisId.parse(id)}.json`); }
  private checkRoot() {
    if (existsSync(this.root)) { const stat = lstatSync(this.root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid entity directory.'); }
  }
  read(id: string): EntityAnalysisEnvelope {
    assertWorkspaceReady(this.workspaceRoot); this.checkRoot(); const path = this.path(id); const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid entity file.');
    const entry = EntityAnalysisEnvelopeSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (entry.analysisId !== id) throw new Error('Entity analysis identity mismatch.');
    validateEntityAnalysisHistory(entry); return entry;
  }
  write(input: EntityAnalysisWrite, actorInput: KnowledgeActor): EntityAnalysisEnvelope['receipts'][number] {
    const command = EntityAnalysisWriteSchema.parse(input); const actor = KnowledgeActorSchema.parse(actorInput);
    const digest = `sha256:${createHash('sha256').update(canonicalJson({ actor, command })).digest('hex')}`;
    this.checkRoot(); const path = this.path(command.analysisId);
    return withWorkspaceWrite(this.workspaceRoot, () => {
      recoverStorageLock(`${path}.lock`);
      return withFileLock(`${path}.lock`, () => {
      const existing = existsSync(path) ? this.read(command.analysisId) : undefined;
      const next = applyEntityAnalysisWrite(existing, command, actor, digest);
      if (next !== existing) {
        if (Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) throw new Error('Entity capacity exceeded.');
        writeJsonFileAtomic(path, next);
      }
      return next.receipts.find(receipt => receipt.requestId === command.requestId)!;
      }, { recoverStale: false });
    });
  }
}
