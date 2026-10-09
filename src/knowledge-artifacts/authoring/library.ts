import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { withFileLock } from '../../shared/file-lock.js';
import { validateCarrierSkill } from './knowledge-content.js';
import { distributableCopyFilter, hashArtifactSource } from '../sources/content-hash.js';
import type { AuthoredArtifactKind, CarrierDetail, CarrierDraft, CarrierRow, CarrierSource, CarrierVersion } from './library-contracts.js';

const uuid = z.string().uuid();
const refSchema = z.strictObject({ knowledgeId: uuid, revisionId: uuid, generation: z.number().int().positive() });
const manifestSchema = z.strictObject({ schemaVersion: z.literal('omk-carrier-v1'), artifactId: uuid, revisionId: uuid, version: z.number().int().positive(), name: z.string().min(1).max(120), directoryName: z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), artifactKind: z.enum(['skill', 'prompt']), savedAt: z.string().datetime(), knowledgeRefs: z.array(refSchema).max(1000), contentHash: z.string().regex(/^[a-f0-9]{64}$/), baseline: z.strictObject({ locator: z.string(), revisionId: uuid.nullable(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).nullable() });
const filename = (kind: AuthoredArtifactKind, directoryName: string) => kind === 'skill' ? 'SKILL.md' : `${directoryName}.md`;
function regular(path: string) { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('carrier_capacity_or_invalid_file'); return readFileSync(path, 'utf8'); }
function directory(path: string, create = false) { if (create) mkdirSync(path, { recursive: true }); const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('carrier_invalid_directory'); }
function boundedTree(root: string) {
  let bytes = 0; let entries = 0;
  const include = distributableCopyFilter(root);
  const walk = (path: string) => { for (const entry of readdirSync(path)) { const file = join(path, entry); if (!include(file)) continue; if (++entries > 1000) throw new Error('carrier_capacity_exceeded'); const stat = lstatSync(file); if (stat.isDirectory()) walk(file); else if (stat.isFile()) { bytes += stat.size; if (bytes > 64 * 1024 * 1024) throw new Error('carrier_capacity_exceeded'); } else throw new Error('carrier_invalid_asset'); } };
  walk(root);
}

/** Version publication is one directory rename; a cancelled or failed save never replaces a previous version. */
export class CarrierLibrary {
  private readonly root: string;
  constructor(workspace: string) {
    if (!workspace.trim()) throw new Error('carrier_workspace_required');
    const selected = resolve(workspace);
    // Canonicalize an existing explicitly selected workspace; reject redirects inside the owned library.
    this.root = join(existsSync(selected) ? realpathSync(selected) : selected, 'artifacts');
  }
  private folder(id: string, create = false) { uuid.parse(id); if (create) { directory(this.root, true); directory(join(this.root, id), true); } else { directory(this.root); directory(join(this.root, id)); } return join(this.root, id); }
  private versions(id: string) { const folder = this.folder(id); return readdirSync(folder).filter(name => /^v[1-9]\d*$/.test(name)).map(name => Number(name.slice(1))).sort((a, b) => b - a); }
  list(): CarrierRow[] {
    if (!existsSync(this.root)) return [];
    directory(this.root);
    return readdirSync(this.root).filter(id => uuid.safeParse(id).success).flatMap(id => {
      if (!this.versions(id).length) return [];
      const { artifactId, name, artifactKind, version, savedAt, locator, drifted } = this.show(id);
      return [{ artifactId, name, artifactKind, version, savedAt, locator, drifted }];
    }).sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.artifactId.localeCompare(b.artifactId));
  }
  show(id: string, version?: number): CarrierDetail {
    const versions = this.versions(id); const selected = version ?? versions[0];
    if (!selected || !versions.includes(selected)) throw new Error('carrier_version_missing');
    const read = (value: number) => { const folder = join(this.folder(id), `v${value}`); directory(folder); const manifest = manifestSchema.parse(JSON.parse(regular(join(folder, 'manifest.json')))); if (manifest.artifactId !== id || manifest.version !== value) throw new Error('carrier_identity_mismatch'); return manifest; };
    const manifest = read(selected); const container = join(this.folder(id), `v${selected}`, 'content'); directory(container);
    const contentRoot = manifest.artifactKind === 'skill' ? join(container, manifest.directoryName) : container; directory(contentRoot);
    const locator = join(contentRoot, filename(manifest.artifactKind, manifest.directoryName)); const content = regular(locator); boundedTree(contentRoot);
    const hash = hashArtifactSource(manifest.artifactKind === 'skill' ? contentRoot : locator, manifest.artifactKind === 'skill');
    return { ...manifest, content, locator, artifactPath: manifest.artifactKind === 'skill' ? contentRoot : locator, drifted: hash !== manifest.contentHash, versions: versions.map(value => { const { version, revisionId, savedAt } = read(value); return { version, revisionId, savedAt }; }) };
  }
  baseline(source: CarrierSource, kind: AuthoredArtifactKind): { content: string; hash: string | null; locator?: string; copyRoot?: string; detail?: CarrierDetail } {
    if (source.sourceKind === 'new') return { content: '', hash: null };
    let locator: string; let detail: CarrierDetail | undefined;
    if (source.sourceKind === 'library') { detail = this.show(source.artifactId); if (detail.artifactKind !== kind || detail.drifted) throw new Error('carrier_conflict'); locator = detail.locator; }
    else { locator = realpathSync(resolve(source.path)); }
    const content = regular(locator);
    const copyRoot = kind === 'skill' && basename(locator) === 'SKILL.md' ? dirname(locator) : undefined;
    if (copyRoot) {
      const destination = relative(copyRoot, this.root);
      if (!destination || !isAbsolute(destination) && destination !== '..' && !destination.startsWith(`..${sep}`)) throw new Error('carrier_source_contains_destination');
      boundedTree(copyRoot);
    }
    return { content, hash: hashArtifactSource(copyRoot ?? locator, !!copyRoot), locator, ...(copyRoot ? { copyRoot } : {}), ...(detail ? { detail } : {}) };
  }
  save(draft: CarrierDraft, signal?: AbortSignal, beforePublish?: () => void): CarrierDetail {
    signal?.throwIfAborted();
    if (!draft.content.trim() || Buffer.byteLength(draft.content) > 2 * 1024 * 1024) throw new Error('carrier_capacity_exceeded');
    manifestSchema.shape.directoryName.parse(draft.directoryName);
    if (draft.artifactKind === 'skill') validateCarrierSkill(draft.content, draft.directoryName);
    const folder = this.folder(draft.artifactId, true);
    return withFileLock(join(folder, 'write.lock'), () => {
      signal?.throwIfAborted();
      for (const name of readdirSync(folder)) if (/^\.staging-[a-zA-Z0-9]+$/.test(name)) rmSync(join(folder, name), { recursive: true, force: true });
      const baseline = this.baseline(draft.source, draft.artifactKind);
      if ((baseline.detail?.revisionId ?? null) !== draft.baselineRevisionId || baseline.hash !== draft.baselineHash || (draft.source.sourceKind !== 'library' && this.versions(draft.artifactId).length)) throw new Error('carrier_conflict');
      if (draft.source.sourceKind === 'library' && (draft.source.artifactId !== draft.artifactId || baseline.detail?.directoryName !== draft.directoryName)) throw new Error('carrier_identity_mismatch');
      const version = (baseline.detail?.version ?? 0) + 1;
      const stage = mkdtempSync(join(folder, '.staging-'));
      try {
        mkdirSync(join(stage, 'content'));
        const contentRoot = join(stage, 'content', ...(draft.artifactKind === 'skill' ? [draft.directoryName] : []));
        if (baseline.copyRoot) cpSync(baseline.copyRoot, contentRoot, { recursive: true, filter: distributableCopyFilter(baseline.copyRoot) });
        else if (draft.artifactKind === 'skill') mkdirSync(contentRoot);
        if (baseline.copyRoot && hashArtifactSource(contentRoot, true) !== baseline.hash) throw new Error('carrier_conflict');
        writeFileSync(join(contentRoot, filename(draft.artifactKind, draft.directoryName)), draft.content);
        const contentHash = hashArtifactSource(draft.artifactKind === 'skill' ? contentRoot : join(contentRoot, filename(draft.artifactKind, draft.directoryName)), draft.artifactKind === 'skill');
        const manifest: CarrierVersion = { schemaVersion: 'omk-carrier-v1', artifactId: draft.artifactId, revisionId: randomUUID(), version, name: draft.name, directoryName: draft.directoryName, artifactKind: draft.artifactKind, savedAt: new Date().toISOString(), knowledgeRefs: draft.knowledgeRefs, contentHash, baseline: baseline.locator && baseline.hash ? { locator: baseline.locator, contentHash: baseline.hash, revisionId: baseline.detail?.revisionId ?? null } : null };
        writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifestSchema.parse(manifest), null, 2));
        // Verify the complete baseline again after copying dependent assets.
        const finalBaseline = this.baseline(draft.source, draft.artifactKind);
        if (finalBaseline.hash !== draft.baselineHash || (finalBaseline.detail?.revisionId ?? null) !== draft.baselineRevisionId) throw new Error('carrier_conflict');
        beforePublish?.(); signal?.throwIfAborted(); renameSync(stage, join(folder, `v${version}`));
      } finally { rmSync(stage, { recursive: true, force: true }); }
      return this.show(draft.artifactId);
    });
  }
}
