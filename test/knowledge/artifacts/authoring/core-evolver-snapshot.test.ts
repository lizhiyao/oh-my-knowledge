import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';
import { evolveSkillCore, materializeCoreEvolveSnapshot } from '../../../../src/knowledge/artifacts/authoring/core-evolver.js';
import { applySkillTextEdits } from '../../../../src/knowledge/artifacts/authoring/text-edits.js';
import { digestCanonicalJson } from '../../../../src/eval-core/contracts/index.js';
import { compositeAggregate, compositeCoverage, compositeGroupId, type CompositeLayerEntry } from '../../../../src/eval-workflows/measurement/analysis/composite-table.js';
import type { StoredCoreRunArtifacts } from '../../../../src/eval-workflows/artifact-store/index.js';

const executor = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/executors/index.js', () => ({ createExecutor: () => executor }));

// A synthetic evaluatePair port result for the authoring loop. Core verification is tested
// separately; this fixture must still satisfy the composite table's real content validator.
function measuredPair(controlScore: number, treatmentScore: number): StoredCoreRunArtifacts {
  const groups = [['control', controlScore], ['treatment', treatmentScore]].map(([target, score]) => {
    const layers: CompositeLayerEntry[] = [{
      binding: { layerId: 'fact', analysisResultId: 'assertions', sourceKind: 'assertion-layer', selector: 'fact' },
      sourceGroupId: digestCanonicalJson('source'), layerStatus: 'observed', score: Number(score),
    }];
    const group = {
      targetId: String(target), sampleId: 'sample', trialIndex: 0,
      trialId: digestCanonicalJson(target), samplingUnitIds: { pairingBlockId: digestCanonicalJson('sample') },
      layers, coverage: compositeCoverage(layers), aggregate: compositeAggregate(layers),
    };
    return { ...group, groupId: compositeGroupId(group) };
  });
  return {
    plan: {
      definition: { comparisons: [{ controlTargetId: 'control', treatmentTargetIds: ['treatment'] }] },
      execution: { targets: ['control', 'treatment'].map((targetId) => ({ targetKind: 'skill', targetId })) },
    },
    analysis: { records: [{ analysisStatus: 'completed', outputSchema: { schemaVersion: 'omk.composite-table/v1' },
      value: { schemaVersion: 'omk.composite-table/v1', groups } }] },
    report: { decision: { decisionStatus: 'decided', verdict: 'PROGRESS', reasonCodes: ['release-gates-passed'] },
      budgetSummary: { scopes: [] } },
    manifest: { runId: 'fixture-run' },
  } as unknown as StoredCoreRunArtifacts;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

describe('Core evolve artifact snapshots', () => {
  it.each([false, true])('preserves source bytes and pinned assets, refusing writeback on source drift=%s', async (sourceDrift) => {
    const root = await mkdtemp(join(tmpdir(), 'omk-evolve-source-bytes-'));
    temporaryDirectories.push(root);
    const skillPath = join(root, 'SKILL.md');
    const original = '\n# Skill\n原始约束。\n\n';
    writeFileSync(skillPath, original);
    mkdirSync(join(root, 'references'));
    const assetPath = join(root, 'references', 'rules.md');
    writeFileSync(assetPath, 'pinned rules');
    let generations = 0;
    executor.mockImplementation(async () => {
      generations += 1;
      if (sourceDrift) writeFileSync(assetPath, 'external rules');
      return { ok: true, output: generations === 1
        ? JSON.stringify({ summary: 'clarify', edits: [{ oldText: '原始约束', newText: '明确约束' }] })
        : generations === 2 ? JSON.stringify({ summary: 'no change', edits: [] }) : 'invalid JSON', costUSD: 0 };
    });
    const measured: string[][] = [];
    const pending = evolveSkillCore({
      skillPath, isDirectorySkill: true, rounds: 3, target: null,
      model: 'fixture', improveModel: 'fixture', executorName: 'fixture', timeoutMs: 1_000,
      writeBackToSource: true, improveMode: 'agent', editBudget: 0.3, rejectMemory: false,
      async evaluatePair(control, treatment) {
        measured.push([control, treatment]);
        assert.equal(readFileSync(join(treatment, 'references', 'rules.md'), 'utf8'), 'pinned rules');
        if (control === 'baseline') {
          assert.equal(readFileSync(join(treatment, 'SKILL.md'), 'utf8'), original);
          return measuredPair(1, 2);
        }
        return measuredPair(2, 5);
      },
    });
    if (sourceDrift) await assert.rejects(pending, /源载体已被修改/);
    else {
      const result = await pending;
      assert.equal(result.bestRound, 1);
      assert.deepEqual(result.trajectory.map((entry) => entry.accepted), [true, true, false, false]);
      assert.equal(result.runId, 'fixture-run');
    }
    assert.equal(measured.length, sourceDrift ? 2 : 3);
    assert.equal(readFileSync(skillPath, 'utf8'), sourceDrift ? original : original.replace('原始约束', '明确约束'));
    assert.equal(readFileSync(assetPath, 'utf8'), sourceDrift ? 'external rules' : 'pinned rules');
  });

  it('applies only unique ordered text fragments and refuses ambiguous or redirected edits', () => {
    const original = '\nkeep\nold\n';
    const edit = applySkillTextEdits(original, JSON.stringify({ summary: 'update', edits: [
      { oldText: 'old', newText: 'first' }, { oldText: 'first', newText: 'last' },
    ] }));
    assert.equal(edit.content, '\nkeep\nlast\n');
    assert.equal(edit.editCount, 2);
    for (const response of [
      { summary: 'missing', edits: [{ oldText: 'missing', newText: 'x' }] },
      { summary: 'redirect', edits: [{ oldText: 'old', newText: 'x', file: '../other.md' }] },
      { summary: 'invalid second edit', edits: [{ oldText: 'old', newText: 'first' }, { oldText: 'missing', newText: 'x' }] },
    ]) assert.throws(() => applySkillTextEdits(original, JSON.stringify(response)));
    assert.throws(() => applySkillTextEdits('aaa', JSON.stringify({
      summary: 'overlapping matches', edits: [{ oldText: 'aa', newText: 'x' }],
    })));
  });

  it('preserves a directory skill construct while excluding OMK-owned state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omk-core-evolve-snapshot-'));
    temporaryDirectories.push(root);
    const skillDirectory = join(root, 'review');
    const evolveDirectory = join(skillDirectory, 'evolve');
    mkdirSync(join(skillDirectory, 'references'), { recursive: true });
    mkdirSync(join(skillDirectory, '.omk'), { recursive: true });
    mkdirSync(join(evolveDirectory, 'review.r1'), { recursive: true });
    writeFileSync(join(skillDirectory, 'SKILL.md'), 'old skill');
    writeFileSync(join(skillDirectory, 'references', 'rules.md'), 'rules');
    writeFileSync(join(skillDirectory, '.omk', 'eval-samples.json'), '[]');
    writeFileSync(join(evolveDirectory, 'review.r1', 'stale.md'), 'stale');

    const snapshot = materializeCoreEvolveSnapshot({
      skillDirectory,
      evolveDirectory,
      skillName: 'review',
      round: 1,
      content: 'new skill',
      isDirectorySkill: true,
    });

    assert.equal(readFileSync(snapshot.contentPath, 'utf8'), 'new skill');
    assert.equal(readFileSync(join(snapshot.root, 'references', 'rules.md'), 'utf8'), 'rules');
    assert.equal(existsSync(join(snapshot.root, '.omk')), false);
    assert.equal(existsSync(join(snapshot.root, 'evolve')), false);
    assert.equal(existsSync(join(snapshot.root, 'stale.md')), false);
  });

  it('keeps a flat-file skill as a standalone markdown candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omk-core-evolve-flat-'));
    temporaryDirectories.push(root);
    const evolveDirectory = join(root, 'evolve');
    mkdirSync(evolveDirectory, { recursive: true });
    const snapshot = materializeCoreEvolveSnapshot({
      skillDirectory: root,
      evolveDirectory,
      skillName: 'review',
      round: 2,
      content: 'flat candidate',
      isDirectorySkill: false,
    });
    assert.equal(snapshot.root, join(evolveDirectory, 'review.r2.md'));
    assert.equal(readFileSync(snapshot.root, 'utf8'), 'flat candidate');
  });
});
