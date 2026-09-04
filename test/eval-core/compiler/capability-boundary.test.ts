import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import * as publicCore from '../../../src/eval-core/index.js';

describe('Evaluation Core capability package boundary', () => {
  it.each([
    'oh-my-knowledge/dist/eval-core/internal/sealed-run-plan.js',
    'oh-my-knowledge/dist/eval-core/contracts/sealed-run-plan.js',
    'oh-my-knowledge/dist/eval-core/sealed-run-plan.js',
  ])('does not expose the RunPlan issuer at %s', (specifier) => {
    // This process boundary is the contract: source-level relative imports remain available to Core.
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `try {
        await import(${JSON.stringify(specifier)});
        process.exitCode = 2;
      } catch (error) {
        process.exitCode = error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' ? 0 : 1;
      }`,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it('does not expose the RunPlan issuer through the public eval-core barrel', () => {
    expect('sealRunPlan' in publicCore).toBe(false);
  });
});
