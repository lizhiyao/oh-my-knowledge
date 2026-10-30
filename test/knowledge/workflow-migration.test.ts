import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planKnowledgeWorkflowMigration, applyKnowledgeWorkflowMigration } from '../../src/knowledge/adapters/workflow-migration.js';
import * as publication from '../../src/knowledge/adapters/durable-publication.js';
import { FileSourceStore } from '../../src/knowledge/adapters/source-store.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileKnowledgeAssociationStore } from '../../src/knowledge/adapters/association-store.js';
import { FileKnowledgeReviewStore } from '../../src/knowledge/adapters/review-store.js';
import { FileKnowledgeTags } from '../../src/knowledge/adapters/knowledge-tags.js';
import { createLocalKnowledgeReview } from '../../src/knowledge/application/local.js';
import { knowledgeBodyRef } from '../../src/knowledge/adapters/body-digest.js';
import { knowledgeReviewSources } from '../../src/knowledge/reviews.js';
import { assertSourceMigrationComplete } from '../../src/evidence/storage/knowledge-workspace.js';
import { seedKnowledgeWorkspace } from '../cli/knowledge-fixtures.js';
import { testDirectory } from '../helpers/temp-directory.js';

afterEach(() => vi.restoreAllMocks());
const actor = { actorKind: 'agent' as const, actorId: 'workflow-migration-fixture', executionRef: 'authored-migration-not-native' };
const at = '2026-10-30T00:00:00.000Z';
const marker = '.source-migration.json';
const sha = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function put(root: string, path: string, bytes: string | Uint8Array) {
  const destination = join(root, path); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, bytes); return destination;
}
function fingerprint(root: string) {
  const directories: string[] = [], files: { path: string; bytes: number; digest: string }[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isDirectory()) { directories.push(relative(root, path)); visit(path); }
      else files.push({ path: relative(root, path), bytes: stat.size, digest: sha(readFileSync(path)) });
    }
  };
  visit(root); return { directories, files };
}

/** Current public stores create the retained knowledge; opaque old dispatch evidence is archive-only. No model or valid native execution is fabricated. */
function fixture() {
  const root = realpathSync(testDirectory('omk-workflow-migration-')), sourceRoot = join(root, 'old'), targetRoot = join(root, 'new');
  mkdirSync(sourceRoot);
  const seeded = seedKnowledgeWorkspace(sourceRoot, 'workflow3-migration');
  const knowledge = new FileKnowledgeStore(join(sourceRoot, 'items'), 'local', sourceRoot);
  const entities = new FileEntityAnalysisStore(join(sourceRoot, 'entities'), sourceRoot);
  const associations = new FileKnowledgeAssociationStore(join(sourceRoot, 'associations'), 'local', knowledge, entities, sourceRoot);
  const bodyRef = knowledgeBodyRef(seeded.body), originalProjection = associations.read(seeded.body.knowledgeId);
  knowledge.write({ commandKind: 'record_maintenance', requestId: randomUUID(), knowledgeId: seeded.body.knowledgeId,
    expectedGeneration: knowledge.read(seeded.body.knowledgeId).generation,
    maintenance: { revisionId: seeded.body.revisionId, choice: 'retain', actor, at, reason: 'Preserve the original bounded retention opinion.' } }, actor);
  associations.write({ commandKind: 'record_review', requestId: randomUUID(), knowledgeId: seeded.body.knowledgeId,
    expectedGeneration: originalProjection.generation,
    review: { projectionRevisionId: originalProjection.writeHeadRevisionId, choice: 'accept', actor, at, reason: 'Original association opinion, not source coverage approval.' } }, actor);
  createLocalKnowledgeReview(sourceRoot, actor).reviewContent({ requestId: randomUUID(), bodyRef,
    sources: knowledgeReviewSources(seeded.body), expectedGeneration: 0, expectedHeadEventId: null,
    status: 'reviewed_with_limits', reason: 'Original review of this precise body, not workflow4 permission.',
    limitations: ['Authored fixture; not factual acceptance or human Gold.'], findings: [] });
  new FileKnowledgeTags(join(sourceRoot, 'tags'), 'local', sourceRoot).write(seeded.body.knowledgeId, 0, ['migration/preserved'], actor);

  const oldRunId = randomUUID();
  put(sourceRoot, `generation-journals/${oldRunId}.json`, JSON.stringify({ schemaVersion: 3, workflowId: 'knowledge-body-first/v3',
    runId: oldRunId, status: 'active', stage: { state: 'claimed', dispatchOutcome: 'unknown' }, fixtureKind: 'opaque-original-not-an-admitted-journal' }) + '\n');
  put(sourceRoot, `generation-journals/outcomes/${oldRunId}.native`, Buffer.from([0, 255, 13, 10, 240, 159, 153, 130]));
  put(sourceRoot, 'auto-extraction/old-permission.json', '{"schemaVersion":3,"workflowId":"knowledge-body-first/v3","enabled":true,"maxCalls":20,"callsUsed":2}\r\n');
  put(sourceRoot, 'auto-extraction/schedule-old.json', '{"workflowId":"knowledge-body-first/v3","firstCallNumber":3,"mustNotResume":true}\n');
  put(sourceRoot, 'migration/previous/original/evidence.bin', Buffer.from([255, 0, 10]));
  put(sourceRoot, marker, JSON.stringify({ migrationKind: 'knowledge-source2-to3', schemaVersion: 1, migrationId: randomUUID(), planDigest: sha('historical plan'), state: 'complete' }) + '\n');
  mkdirSync(join(sourceRoot, 'empty-historical-directory'));
  const matchingBuildArchivePath = put(root, 'matching-workflow3.tgz', Buffer.from([31, 139, 8, 0, 255, 10]));
  const input = { migrationId: randomUUID(), sourceRoot, targetRoot, namespace: 'local', actor, at, matchingBuildArchivePath,
    matchingBuildId: 'authored-archive-bytes-not-an-installable-runtime' };
  return { root, sourceRoot, targetRoot, input, seeded, bodyRef, knowledge, entities, associations };
}

describe('explicit workflow3 to workflow4 independent-copy migration', () => {
  it('preflights without writing and preserves exact source, content, catalog, association, review and tag identities', () => {
    const f = fixture(), original = fingerprint(f.sourceRoot), plan = planKnowledgeWorkflowMigration(f.input);
    expect(existsSync(f.targetRoot)).toBe(false);
    expect(planKnowledgeWorkflowMigration(f.input)).toEqual(plan);
    expect(fingerprint(f.sourceRoot)).toEqual(original);
    expect(plan.migrationKind).toBe('knowledge-workflow3-to4');
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.inventory)).toBe(true);
    expect(Object.isFrozen(plan.inventory[0])).toBe(true);
    const result = applyKnowledgeWorkflowMigration(plan, plan.planDigest);
    expect(result).toEqual({ migrationId: plan.migrationId, planDigest: plan.planDigest, state: 'complete', archiveRoot: plan.archiveRoot, preservedFiles: plan.activePaths.length });

    const source = new FileSourceStore(join(f.targetRoot, 'sources'), f.targetRoot).read(f.seeded.source.snapshotId, f.seeded.source.sourceVersion);
    expect(source).toMatchObject({ status: 'available', snapshot: f.seeded.source });
    const knowledge = new FileKnowledgeStore(join(f.targetRoot, 'items'), 'local', f.targetRoot);
    const entities = new FileEntityAnalysisStore(join(f.targetRoot, 'entities'), f.targetRoot);
    const associations = new FileKnowledgeAssociationStore(join(f.targetRoot, 'associations'), 'local', knowledge, entities, f.targetRoot);
    expect(knowledge.read(f.seeded.body.knowledgeId)).toEqual(f.knowledge.read(f.seeded.body.knowledgeId));
    expect(entities.read(f.seeded.analysis.history.analysisId)).toEqual(f.entities.read(f.seeded.analysis.history.analysisId));
    expect(associations.read(f.seeded.body.knowledgeId)).toEqual(f.associations.read(f.seeded.body.knowledgeId));
    expect(new FileKnowledgeReviewStore(join(f.targetRoot, 'reviews'), 'local', f.targetRoot).read(f.seeded.body.knowledgeId))
      .toEqual(new FileKnowledgeReviewStore(join(f.sourceRoot, 'reviews'), 'local', f.sourceRoot).read(f.seeded.body.knowledgeId));
    expect(new FileKnowledgeTags(join(f.targetRoot, 'tags'), 'local', f.targetRoot).read(f.seeded.body.knowledgeId))
      .toEqual(new FileKnowledgeTags(join(f.sourceRoot, 'tags'), 'local', f.sourceRoot).read(f.seeded.body.knowledgeId));
    for (const path of plan.activePaths) expect(readFileSync(join(f.targetRoot, path))).toEqual(readFileSync(join(f.sourceRoot, path)));
    for (const file of plan.inventory) {
      const archived = join(plan.archiveRoot, 'original', file.path), originalPath = join(f.sourceRoot, file.path);
      expect(readFileSync(archived)).toEqual(readFileSync(originalPath));
      expect(lstatSync(archived).ino).not.toBe(lstatSync(originalPath).ino);
    }
    expect(existsSync(join(plan.archiveRoot, 'original', 'empty-historical-directory'))).toBe(true);
    expect(readFileSync(join(plan.archiveRoot, 'matching-build', basename(f.input.matchingBuildArchivePath)))).toEqual(readFileSync(f.input.matchingBuildArchivePath));
    expect(existsSync(join(f.targetRoot, 'generation-journals'))).toBe(false);
    expect(existsSync(join(f.targetRoot, 'auto-extraction'))).toBe(false);
    expect(existsSync(join(f.targetRoot, 'source-ledgers'))).toBe(false);
    expect(existsSync(join(f.targetRoot, 'source-coverage'))).toBe(false);
    const state = JSON.parse(readFileSync(join(f.targetRoot, marker), 'utf8'));
    expect(state).toMatchObject({ migrationKind: 'knowledge-workflow3-to4', migrationId: plan.migrationId, planDigest: plan.planDigest, state: 'complete' });
    expect(plan.activePaths.some(path => /^(?:generation-journals|auto-extraction|migration)\//u.test(path) || path === marker)).toBe(false);
    expect(fingerprint(f.sourceRoot)).toEqual(original);
    const completed = fingerprint(f.targetRoot);
    expect(applyKnowledgeWorkflowMigration(plan, plan.planDigest)).toEqual(result);
    expect(fingerprint(f.targetRoot)).toEqual(completed);
  });

  it.each(['request_digest', 'plan_payload', 'source_bytes', 'source_inventory', 'matching_build'] as const)('refuses changed %s before creating a destination', change => {
    const f = fixture(), plan = planKnowledgeWorkflowMigration(f.input);
    let appliedPlan = plan, confirmation = plan.planDigest;
    if (change === 'request_digest') confirmation = sha('another confirmed migration');
    if (change === 'plan_payload') appliedPlan = { ...plan, actor: { actorKind: 'human', actorId: 'different-actor' } };
    if (change === 'source_bytes') {
      const file = join(f.sourceRoot, plan.activePaths.find(path => path.startsWith('items/'))!);
      writeFileSync(file, readFileSync(file, 'utf8') + '\n');
    }
    if (change === 'source_inventory') put(f.sourceRoot, 'new-original.txt', 'new material after confirmation');
    if (change === 'matching_build') writeFileSync(f.input.matchingBuildArchivePath, 'replacement package bytes');
    const original = fingerprint(f.sourceRoot);
    expect(() => applyKnowledgeWorkflowMigration(appliedPlan, confirmation)).toThrow();
    expect(existsSync(f.targetRoot)).toBe(false);
    expect(fingerprint(f.sourceRoot)).toEqual(original);
  });

  it('resumes an acknowledged-loss prefix only under the exact plan, without resetting retained histories', () => {
    const f = fixture(), plan = planKnowledgeWorkflowMigration(f.input), original = fingerprint(f.sourceRoot);
    const active = join(f.targetRoot, plan.activePaths[0]), publish = publication.publishKnowledgeBytes;
    let interrupted = false;
    vi.spyOn(publication, 'publishKnowledgeBytes').mockImplementation((path, bytes, workspace, exclusive) => {
      publish(path, bytes, workspace, exclusive);
      if (path === active && !interrupted) { interrupted = true; throw new Error('authored copy acknowledgement loss'); }
    });
    expect(() => applyKnowledgeWorkflowMigration(plan, plan.planDigest)).toThrow('authored copy acknowledgement loss');
    vi.restoreAllMocks(); expect(interrupted).toBe(true);
    expect(readFileSync(active)).toEqual(readFileSync(join(f.sourceRoot, plan.activePaths[0])));
    expect(JSON.parse(readFileSync(join(f.targetRoot, marker), 'utf8')).state).toBe('in_progress');
    expect(() => assertSourceMigrationComplete(f.targetRoot)).toThrow('knowledge_storage_unsupported');
    const prefix = fingerprint(f.targetRoot);
    expect(() => applyKnowledgeWorkflowMigration({ ...plan, migrationId: randomUUID() }, plan.planDigest)).toThrow();
    expect(fingerprint(f.targetRoot)).toEqual(prefix);
    expect(applyKnowledgeWorkflowMigration(plan, plan.planDigest).state).toBe('complete');
    expect(fingerprint(f.sourceRoot)).toEqual(original);
    expect(new FileKnowledgeStore(join(f.targetRoot, 'items'), 'local', f.targetRoot).read(f.seeded.body.knowledgeId)).toEqual(f.knowledge.read(f.seeded.body.knowledgeId));
    expect(existsSync(join(f.targetRoot, 'auto-extraction'))).toBe(false);
  });

  it('preserves a cancelled durable prefix and admits only the same exact recovery', () => {
    const f = fixture(), plan = planKnowledgeWorkflowMigration(f.input), controller = new AbortController();
    const active = join(f.targetRoot, plan.activePaths[0]), publish = publication.publishKnowledgeBytes;
    vi.spyOn(publication, 'publishKnowledgeBytes').mockImplementation((path, bytes, workspace, exclusive) => {
      publish(path, bytes, workspace, exclusive);
      if (path === active) controller.abort(new Error('authored copy cancellation'));
    });
    expect(() => applyKnowledgeWorkflowMigration(plan, plan.planDigest, { signal: controller.signal })).toThrow('authored copy cancellation');
    vi.restoreAllMocks(); expect(existsSync(active)).toBe(true);
    expect(JSON.parse(readFileSync(join(f.targetRoot, marker), 'utf8')).state).toBe('in_progress');
    expect(applyKnowledgeWorkflowMigration(plan, plan.planDigest).state).toBe('complete');
  });

  it('refuses unrelated destination data and never replaces edited or resurrects deleted completed content', () => {
    const occupied = fixture(), occupiedPlan = planKnowledgeWorkflowMigration(occupied.input);
    put(occupied.targetRoot, 'user-data.txt', 'do not overwrite');
    const beforeOccupied = fingerprint(occupied.targetRoot);
    expect(() => applyKnowledgeWorkflowMigration(occupiedPlan, occupiedPlan.planDigest)).toThrow();
    expect(fingerprint(occupied.targetRoot)).toEqual(beforeOccupied);
    for (const change of ['added', 'edited', 'deleted', 'hardlinked', 'source_changed', 'build_changed'] as const) {
      const f = fixture(), plan = planKnowledgeWorkflowMigration(f.input); applyKnowledgeWorkflowMigration(plan, plan.planDigest);
      const file = join(f.targetRoot, plan.activePaths.find(path => path.startsWith('items/'))!);
      if (change === 'added') put(f.targetRoot, 'later-user-data.txt', 'new material');
      else if (change === 'edited') writeFileSync(file, readFileSync(file, 'utf8') + '\n');
      else if (change === 'deleted') rmSync(file);
      else if (change === 'hardlinked') {
        const original = join(f.sourceRoot, relative(f.targetRoot, file)); rmSync(file); linkSync(original, file);
      } else if (change === 'source_changed') {
        const original = join(f.sourceRoot, plan.activePaths[0]); writeFileSync(original, readFileSync(original, 'utf8') + '\n');
      } else writeFileSync(f.input.matchingBuildArchivePath, 'changed after completed migration');
      const changed = fingerprint(f.targetRoot);
      expect(() => applyKnowledgeWorkflowMigration(plan, plan.planDigest)).toThrow();
      expect(fingerprint(f.targetRoot)).toEqual(changed);
      if (change === 'deleted') expect(existsSync(file)).toBe(false);
      if (change === 'hardlinked') expect(lstatSync(file).ino).toBe(lstatSync(join(f.sourceRoot, relative(f.targetRoot, file))).ino);
    }
  });

  it('rejects a matching archive above its byte limit before reading or creating the target', () => {
    const f = fixture(), original = fingerprint(f.sourceRoot);
    truncateSync(f.input.matchingBuildArchivePath, 512 * 1024 * 1024 + 1);
    expect(() => planKnowledgeWorkflowMigration(f.input)).toThrow('capacity');
    expect(existsSync(f.targetRoot)).toBe(false); expect(fingerprint(f.sourceRoot)).toEqual(original);
  });

  it('rejects intersecting workspaces and symbolic source, build and destination aliases without creating files', () => {
    const f = fixture(), original = fingerprint(f.sourceRoot);
    for (const targetRoot of [f.sourceRoot, join(f.sourceRoot, 'nested'), f.root]) {
      expect(() => planKnowledgeWorkflowMigration({ ...f.input, targetRoot })).toThrow();
    }
    const sourceAlias = join(f.root, 'source-alias'); symlinkSync(f.sourceRoot, sourceAlias);
    expect(() => planKnowledgeWorkflowMigration({ ...f.input, sourceRoot: sourceAlias })).toThrow();
    const buildAlias = join(f.root, 'build-alias.tgz'); symlinkSync(f.input.matchingBuildArchivePath, buildAlias);
    expect(() => planKnowledgeWorkflowMigration({ ...f.input, matchingBuildArchivePath: buildAlias })).toThrow();
    const targetAlias = join(f.root, 'target-alias'); symlinkSync(f.sourceRoot, targetAlias);
    expect(() => planKnowledgeWorkflowMigration({ ...f.input, targetRoot: targetAlias })).toThrow();
    const redirected = join(f.sourceRoot, 'sources', 'redirected.json'); symlinkSync(f.input.matchingBuildArchivePath, redirected);
    expect(() => planKnowledgeWorkflowMigration(f.input)).toThrow(); rmSync(redirected);
    expect(existsSync(f.targetRoot)).toBe(false); expect(fingerprint(f.sourceRoot)).toEqual(original);
  });
});
