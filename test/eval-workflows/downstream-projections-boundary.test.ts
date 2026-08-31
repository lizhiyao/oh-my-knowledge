import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('#531 Core downstream projection boundary', () => {
  it('does not import legacy Report/result contracts or switch production consumers', () => {
    const projectionFiles = [
      'src/eval-workflows/downstream-projections/artifact-graph.ts',
      'src/eval-workflows/downstream-projections/contracts.ts',
      'src/eval-workflows/downstream-projections/evolution.ts',
      'src/eval-workflows/downstream-projections/gold.ts',
      'src/eval-workflows/downstream-projections/source.ts',
    ];
    const projectionSource = projectionFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(projectionSource).not.toContain("src/types/report");
    expect(projectionSource).not.toContain("types/report.js");
    expect(projectionSource).not.toMatch(/\bVariantResult\b/);
    expect(projectionSource).not.toMatch(/\bResultEntry\b/);
    expect(projectionSource).not.toMatch(/\.llmScore\b/);
    expect(projectionSource).not.toMatch(/\.compositeScore\b/);

    const legacyConsumers = [
      'src/artifact-graph/eval.ts',
      'src/grading/gold-cli.ts',
      'src/authoring/evolver.ts',
    ].map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(legacyConsumers).not.toContain('downstream-projections');
    expect(legacyConsumers).not.toContain('projectCoreArtifactGraph');
    expect(legacyConsumers).not.toContain('compareGoldToCoreRun');
    expect(legacyConsumers).not.toContain('projectCoreEvolutionEvidence');
  });
});
