import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('#531/#547 Core downstream projection boundary', () => {
  it('keeps projections legacy-free and switches every production consumer once', () => {
    const projectionFiles = [
      'src/eval-workflows/downstream-projections/artifact-graph.ts',
      'src/eval-workflows/downstream-projections/cli.ts',
      'src/eval-workflows/downstream-projections/cli-gate.ts',
      'src/eval-workflows/downstream-projections/contracts.ts',
      'src/eval-workflows/downstream-projections/decision.ts',
      'src/eval-workflows/downstream-projections/diagnostic.ts',
      'src/eval-workflows/downstream-projections/evolution.ts',
      'src/eval-workflows/downstream-projections/gold.ts',
      'src/eval-workflows/downstream-projections/managed.ts',
      'src/eval-workflows/downstream-projections/source.ts',
    ];
    const projectionSource = projectionFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(projectionSource).not.toContain("src/types/report");
    expect(projectionSource).not.toContain("types/report.js");
    expect(projectionSource).not.toMatch(/\bVariantResult\b/);
    expect(projectionSource).not.toMatch(/\bResultEntry\b/);
    expect(projectionSource).not.toMatch(/\.llmScore\b/);
    expect(projectionSource).not.toMatch(/\.compositeScore\b/);

    const cutoverConsumers = [
      'src/cli/commands/eval/index.ts',
      'src/cli/lib/run-core-evaluation.ts',
      'src/managed/evidence.ts',
      'src/cli/commands/eval/gold/compare.ts',
      'src/authoring/core-evolver.ts',
      'src/artifact-graph/core.ts',
      'src/studio/http/request-handler.ts',
    ].map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(cutoverConsumers).toContain('projectCoreCliDryRun');
    expect(cutoverConsumers).toContain('projectCoreCliRunOutcome');
    expect(cutoverConsumers).toContain('projectCoreCliBatchOutcome');
    expect(cutoverConsumers).toContain('projectCoreCliSeriesOutcome');
    expect(cutoverConsumers).toContain('projectCoreManagedEvidence');
    expect(cutoverConsumers).toContain('projectCoreArtifactGraph');
    expect(cutoverConsumers).toContain('compareGoldToCoreRun');
    expect(cutoverConsumers).not.toContain("from '../../eval-workflows/run-evaluation.js'");
    expect(cutoverConsumers).not.toContain('requireEvaluationReport');
    expect(cutoverConsumers).not.toContain('compareGoldToReport');
  });
});
