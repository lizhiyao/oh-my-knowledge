import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('#451 input compilation boundary', () => {
  it('keeps Core production wiring independent from the input compiler prototype', () => {
    const command = readFileSync('src/cli/commands/eval/index.ts', 'utf8');
    expect(command).not.toContain('compileCliEvaluationInput');
    expect(command).not.toContain('input-compilation');
    expect(command).toContain('runCoreEvaluation');
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
