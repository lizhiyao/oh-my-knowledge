import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LibraryEnvelopeSchema, LibraryWriteSchema, type LibraryEnvelope, type LibraryStore, type LibraryWrite } from '../../../knowledge/library/contracts.js';
import { applyLibraryWrite, validateLibraryHistory } from '../../../knowledge/library/history.js';
import { canonicalJson } from '../../../knowledge/store.js';
import { writeJsonFileAtomic } from '../../../shared/atomic-json.js';
import { checkStorageDirectory, withWorkspaceWrite } from './storage-state.js';

const MAX_BYTES = 8 * 1024 * 1024;
/** All object writes share the workspace lock so one entity cannot acquire competing owners. */
export class FileLibraryStore implements LibraryStore {
  private readonly root: string;
  constructor(root: string, private readonly workspaceRoot: string) {
    if (!root.trim() || !workspaceRoot.trim()) throw new Error('Explicit library workspace required.');
    this.root = resolve(root);
  }
  private path(id: string) { return join(this.root, `${LibraryWriteSchema.shape.objectId.parse(id)}.json`); }
  list(): LibraryEnvelope[] {
    checkStorageDirectory(this.workspaceRoot); checkStorageDirectory(this.root);
    if (!existsSync(this.root)) return [];
    const files = readdirSync(this.root).filter(name => name.endsWith('.json')).sort();
    if (files.length > 4096) throw new Error('Library capacity exceeded.');
    let bytes = 0;
    return files.map(name => {
      bytes += lstatSync(join(this.root, name)).size;
      if (bytes > 64 * 1024 * 1024) throw new Error('Library capacity exceeded.');
      // Fail closed: an unreadable object may already own a member.
      return this.read(name.slice(0, -5));
    });
  }
  read(id: string): LibraryEnvelope {
    checkStorageDirectory(this.workspaceRoot); checkStorageDirectory(this.root);
    const path = this.path(id); const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid library file.');
    const history = LibraryEnvelopeSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (history.objectId !== id) throw new Error('Library file identity conflict.');
    validateLibraryHistory(history); return history;
  }
  write(input: LibraryWrite, validate: Parameters<LibraryStore['write']>[1]): LibraryEnvelope {
    const command = LibraryWriteSchema.parse(input);
    const digest = `sha256:${createHash('sha256').update(canonicalJson(command)).digest('hex')}`;
    return withWorkspaceWrite(this.workspaceRoot, () => {
      checkStorageDirectory(this.root); const all = this.list();
      const existing = all.find(value => value.objectId === command.objectId);
      const next = applyLibraryWrite(existing, command, digest);
      if (next === existing) return next;
      if (!existing && all.length >= 4096) throw new Error('Library capacity exceeded.');
      validate(existing, all);
      const bytes = Buffer.byteLength(JSON.stringify(next, null, 2));
      if (bytes > MAX_BYTES || all.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item, null, 2)), 0)
        - (existing ? Buffer.byteLength(JSON.stringify(existing, null, 2)) : 0) + bytes > 64 * 1024 * 1024) throw new Error('Library capacity exceeded.');
      writeJsonFileAtomic(this.path(command.objectId), next); return next;
    });
  }
}
