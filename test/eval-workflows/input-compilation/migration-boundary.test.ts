import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('#451 migration boundary', () => {
  it('does not switch the production omk eval pipeline', () => {
    const command = readFileSync('src/cli/commands/eval/index.ts', 'utf8');
    const workflow = readFileSync('src/eval-workflows/run-evaluation.ts', 'utf8');
    expect(command).not.toContain('compileCliEvaluationInput');
    expect(command).not.toContain('input-compilation');
    expect(workflow).not.toContain('compileCliEvaluationInput');
    expect(workflow).not.toContain('input-compilation');
    expect(command).toContain('parseRunConfig');
    expect(workflow).toContain('executeEvaluationPipeline');
  });

  it('does not introduce a parallel host plan abstraction', () => {
    const files = [
      'src/eval-workflows/input-compilation/types.ts',
      'src/eval-workflows/input-compilation/compile.ts',
      'src/eval-workflows/input-compilation/registry.ts',
    ];
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toContain('HostExecutionPlan');
  });
});
