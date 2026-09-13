import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createJsonFileAtomic, writeJsonFileAtomic } from '../../../shared/atomic-json.js';
import { withFileLock } from '../../../shared/file-lock.js';
import { ExtractionRunSchema, type ExtractionRun, type ExtractionRunStore } from '../runs.js';

export class FileExtractionRunStore implements ExtractionRunStore {
  private readonly root: string;
  constructor(root: string) {
    if (!root.trim()) throw new Error('Explicit extraction run root required.');
    this.root = resolve(root);
  }
  private path(runId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error('Invalid extraction run identity.');
    return join(this.root, `${runId}.json`);
  }
  private check(run: ExtractionRun): ExtractionRun {
    const parsed = ExtractionRunSchema.parse(run);
    if (Buffer.byteLength(JSON.stringify(parsed, null, 2)) > 16 * 1024 * 1024) throw new Error('Extraction run capacity exceeded.');
    return parsed;
  }
  create(run: ExtractionRun): void { createJsonFileAtomic(this.path(run.runId), this.check(run)); }
  read(runId: string): ExtractionRun {
    const path = this.path(runId);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid extraction run file.');
    const run = this.check(JSON.parse(readFileSync(path, 'utf8')));
    if (run.runId !== runId) throw new Error('Extraction run identity mismatch.');
    return run;
  }
  list(): ExtractionRun[] {
    return existsSync(this.root) ? readdirSync(this.root).filter((name) => name.endsWith('.json')).sort()
      .map((name) => this.read(name.slice(0, -5))) : [];
  }
  save(run: ExtractionRun, expectedGeneration: number): void {
    const path = this.path(run.runId);
    withFileLock(`${path}.lock`, () => {
      const current = this.read(run.runId);
      if (current.generation !== expectedGeneration || run.generation !== expectedGeneration + 1
        || run.requestDigest !== current.requestDigest) throw new Error('Extraction run conflict.');
      writeJsonFileAtomic(path, this.check(run));
    }, { recoverStale: false });
  }
}
