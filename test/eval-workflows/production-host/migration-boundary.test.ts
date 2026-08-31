import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function productionHostSource(): string {
  const root = 'src/eval-workflows/production-host';
  return readdirSync(root)
    .filter((file) => file.endsWith('.ts'))
    .sort()
    .map((file) => readFileSync(join(root, file), 'utf8'))
    .join('\n');
}

describe('#539 production host migration boundary', () => {
  it('terminates legacy report and pipeline models outside the new composition root', () => {
    const source = productionHostSource();

    for (const forbidden of [
      'EvaluationReport',
      'ReportStore',
      'VariantResult',
      'evaluation-pipeline',
      'run-evaluation',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('keeps the production CLI and report server disconnected in this migration slice', () => {
    const production = [
      'src/eval-workflows/run-evaluation.ts',
      'src/server/report-server.ts',
    ].map((file) => readFileSync(file, 'utf8')).join('\n');

    expect(production).not.toContain('production-host');
    expect(production).not.toContain('resolveNodeCliEvaluationRequest');
  });
});
