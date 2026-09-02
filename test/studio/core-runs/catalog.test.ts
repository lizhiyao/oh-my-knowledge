import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import {
  createCoreStudioCatalog,
  projectCoreStudioRunDetail,
} from '../../../src/studio/public.js';
import { digestCanonicalJson } from '../../../src/index.js';
import { CoreDownstreamProjectionError } from '../../../src/eval-workflows/downstream-projections/index.js';
import {
  CoreRunArtifactOverlayError,
  createNodeCoreRunArtifactStore,
  createOverlayCoreRunArtifactStore,
  type CoreRunArtifactStore,
  type StoredCoreRunArtifacts,
} from '../../../src/eval-workflows/artifact-store/index.js';
import {
  runConformanceScenario,
  type ConformanceHarnessOptions,
  type ConformanceTarget,
} from '../../eval-core/conformance/harness.js';
import { ConformanceFaultInjector } from '../../eval-core/conformance/fault-injector.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

async function temporaryStore(): Promise<CoreRunArtifactStore> {
  const root = await mkdtemp(join(tmpdir(), 'omk-core-studio-'));
  temporaryDirectories.push(root);
  return createNodeCoreRunArtifactStore(root);
}

async function saveScenario(input: {
  store: CoreRunArtifactStore;
  target: ConformanceTarget;
  runId: string;
  createdAt: string;
  options?: Omit<ConformanceHarnessOptions, 'runId'>;
}): Promise<StoredCoreRunArtifacts> {
  const result = await runConformanceScenario(input.target, {
    ...input.options,
    runId: input.runId,
  });
  return input.store.save({
    runId: input.runId,
    createdAt: input.createdAt,
    plan: result.plan,
    execution: result.execution,
    evaluation: result.evaluation,
    analysis: result.analysis,
    report: result.report,
  });
}

describe('Core Studio catalog', () => {
  it('lists manifest-only cards through the artifact store boundary', async () => {
    const sourceStore = await temporaryStore();
    await saveScenario({
      store: sourceStore,
      target: 'function',
      runId: 'manifest-card',
      createdAt: '2026-08-31T12:00:00.000Z',
    });
    let fullReads = 0;
    const store: CoreRunArtifactStore = {
      ...sourceStore,
      async get(runId) {
        fullReads += 1;
        return sourceStore.get(runId);
      },
    };
    const catalog = createCoreStudioCatalog(store);

    const cards = await catalog.list();
    assert.equal(fullReads, 0);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].cardKind, 'studio-core-run-card');
    assert.equal(cards[0].runId, 'manifest-card');
    assert.equal(cards[0].status.runStatus, 'completed');
    assert.ok(Object.isFrozen(cards[0]));

    const inspected = await catalog.inspect('manifest-card');
    assert.equal(fullReads, 0);
    assert.deepEqual(inspected, cards[0]);
    assert.equal(await catalog.inspect('missing'), undefined);
  });

  it('merges project/global cards and preserves overlay conflict failures', async () => {
    const project = await temporaryStore();
    const global = await temporaryStore();
    await saveScenario({
      store: project,
      target: 'function',
      runId: 'project-run',
      createdAt: '2026-08-31T12:00:00.000Z',
    });
    await saveScenario({
      store: global,
      target: 'rag',
      runId: 'global-run',
      createdAt: '2026-08-31T13:00:00.000Z',
    });
    const catalog = createCoreStudioCatalog(
      createOverlayCoreRunArtifactStore(project, [global]),
    );
    assert.deepEqual((await catalog.list()).map((card) => card.runId), [
      'global-run',
      'project-run',
    ]);

    const duplicateProject = await temporaryStore();
    const duplicateGlobal = await temporaryStore();
    await saveScenario({
      store: duplicateProject,
      target: 'function',
      runId: 'identical-run',
      createdAt: '2026-08-31T12:00:00.000Z',
    });
    await saveScenario({
      store: duplicateGlobal,
      target: 'function',
      runId: 'identical-run',
      createdAt: '2026-08-31T12:00:00.000Z',
    });
    const duplicateCatalog = createCoreStudioCatalog(
      createOverlayCoreRunArtifactStore(duplicateProject, [duplicateGlobal]),
    );
    assert.deepEqual((await duplicateCatalog.list()).map((card) => card.runId), [
      'identical-run',
    ]);

    const conflictingProject = await temporaryStore();
    const conflictingGlobal = await temporaryStore();
    await saveScenario({
      store: conflictingProject,
      target: 'function',
      runId: 'same-run',
      createdAt: '2026-08-31T12:00:00.000Z',
    });
    await saveScenario({
      store: conflictingGlobal,
      target: 'agent',
      runId: 'same-run',
      createdAt: '2026-08-31T12:00:00.000Z',
    });
    const conflicting = createCoreStudioCatalog(
      createOverlayCoreRunArtifactStore(conflictingProject, [conflictingGlobal]),
    );
    await assert.rejects(conflicting.list(), (error: unknown) => (
      error instanceof CoreRunArtifactOverlayError
        && error.code === 'CORE_RUN_ARTIFACT_OVERLAY_ID_CONFLICT'
    ));
  });

  it('projects a JSON-safe detail with exact lineage and no captured content', async () => {
    const store = await temporaryStore();
    const source = await saveScenario({
      store,
      target: 'agent',
      runId: 'agent-detail',
      createdAt: '2026-08-31T12:00:00.000Z',
    });
    const detail = await createCoreStudioCatalog(store).get('agent-detail');
    assert.ok(detail);
    assert.equal(detail.detailKind, 'studio-core-run-detail');
    assert.equal(
      detail.run.artifactSetDigest,
      digestCanonicalJson(source.manifest.documents),
    );
    assert.equal(detail.dataset.sampleCount, 2);
    assert.equal(detail.lineage.length, 5);
    assert.equal(detail.stages.execution.records.length, 4);
    assert.equal(detail.stages.evaluation.records.length, 8);
    assert.ok(detail.stages.analysis.records.length > 0);
    assert.ok(detail.decision);
    assert.ok(Object.isFrozen(detail));
    assert.ok(Object.isFrozen(detail.stages.execution.records));

    const json = JSON.stringify(detail);
    assert.doesNotThrow(() => JSON.parse(json) as unknown);
    for (const protectedValue of [
      'research evaluation core',
      'verify measurement validity',
      'working',
      'done',
      'requiredTools',
      'toolCalls',
      'capabilities',
      'provenanceFacets',
      'implementationManifest',
    ]) {
      assert.ok(!json.includes(protectedValue), `unexpected protected value: ${protectedValue}`);
    }
    assert.ok(!detail.lineage.some((entry) => 'fileName' in entry));
    assert.ok(detail.stages.analysis.records.every((record) => (
      !('schemaUri' in record.outputSchema)
    )));
    assert.ok(detail.stages.evaluation.records.every((record) => (
      record.observations.every((observation) => observation.numericValue === undefined)
    )));
  });

  it('exposes numeric observations and aggregate scalar analysis without raw evidence', async () => {
    const store = await temporaryStore();
    await saveScenario({
      store,
      target: 'rag',
      runId: 'rag-detail',
      createdAt: '2026-08-31T12:00:00.000Z',
    });
    const detail = await createCoreStudioCatalog(store).get('rag-detail');
    assert.ok(detail);
    const observations = detail.stages.evaluation.records.flatMap((record) => (
      record.observations
    ));
    assert.ok(observations.length > 0);
    assert.ok(observations.every((observation) => (
      observation.valueType === 'numeric'
        && typeof observation.numericValue === 'number'
    )));
    assert.ok(detail.stages.analysis.records.some((record) => (
      record.resultType === 'scalar' && typeof record.numericValue === 'number'
    )));
    const json = JSON.stringify(detail);
    assert.ok(!json.includes('calculation'));
    assert.ok(!json.includes('relevantDocumentIds'));
  });

  it('keeps failure codes and orthogonal status while redacting error messages', async () => {
    const store = await temporaryStore();
    await saveScenario({
      store,
      target: 'function',
      runId: 'failed-detail',
      createdAt: '2026-08-31T12:00:00.000Z',
      options: {
        faults: new ConformanceFaultInjector().fail(
          'executor-execute',
          'TOP-SECRET-PROVIDER-MESSAGE',
        ),
      },
    });
    const detail = await createCoreStudioCatalog(store).get('failed-detail');
    assert.ok(detail);
    assert.equal(detail.run.status.runStatus, 'completed');
    assert.equal(detail.run.status.evidenceStatus, 'unresolvable');
    assert.equal(detail.run.status.conclusionStatus, 'inconclusive');
    assert.ok(detail.stages.execution.records.some((record) => (
      record.executionStatus === 'failed' && record.errorCode === 'executor-error'
    )));
    assert.ok(!JSON.stringify(detail).includes('TOP-SECRET-PROVIDER-MESSAGE'));
  });

  it('rejects a detached or altered artifact chain', async () => {
    const store = await temporaryStore();
    const source = await saveScenario({
      store,
      target: 'function',
      runId: 'invalid-detail',
      createdAt: '2026-08-31T12:00:00.000Z',
    });
    const altered = structuredClone(source);
    altered.report.reportId = 'altered-report';
    assert.throws(
      () => projectCoreStudioRunDetail(altered),
      (error: unknown) => (
        error instanceof CoreDownstreamProjectionError
          && error.code === 'CORE_PROJECTION_SOURCE_INVALID'
      ),
    );
  });
});
