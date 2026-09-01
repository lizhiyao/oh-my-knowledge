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

  it('pins the production CLI to the Core host and the report route to Core Studio', () => {
    const command = readFileSync('src/cli/commands/eval/index.ts', 'utf8');
    const runner = readFileSync('src/cli/lib/run-core-evaluation.ts', 'utf8');
    const server = readFileSync('src/server/report-server.ts', 'utf8');

    expect(command).toContain('runCoreEvaluationCommand');
    expect(command).not.toContain('runEvaluation');
    expect(runner).toContain("from '../../eval-workflows/production-host/index.js'");
    expect(runner).toContain('createNodeCliProductionComposition');
    expect(runner).toContain('createProductionEvaluationHost');
    expect(server).toContain('createCoreStudioRouteHandler');
    expect(server).toContain('createEvaluationDisabledReportStore');
  });
});
