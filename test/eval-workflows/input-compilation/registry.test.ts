import { describe, expect, it } from 'vitest';
import Eval from '../../../src/cli/commands/eval/index.js';
import { EVAL_CONFIG_SCHEMA_SOURCE_PATHS } from '../../../src/inputs/eval-config.js';
import {
  CLI_EVALUATION_INPUT_REGISTRY,
  cliEvaluationRegistrySourceKeys,
} from '../../../src/eval-workflows/input-compilation/index.js';

describe('CLI evaluation input registry', () => {
  it('strictly covers the live oclif eval flag set', () => {
    expect(cliEvaluationRegistrySourceKeys('cli-flag')).toEqual(Object.keys(Eval.flags).sort());
  });

  it('strictly covers the machine-enumerable EvalConfig schema paths', () => {
    expect(cliEvaluationRegistrySourceKeys('eval-config')).toEqual(
      [...EVAL_CONFIG_SCHEMA_SOURCE_PATHS].sort(),
    );
  });

  it('gives every raw source key one complete classification', () => {
    const identities = CLI_EVALUATION_INPUT_REGISTRY.map((entry) => (
      `${entry.sourceKind}:${entry.sourceKey}`
    ));
    expect(new Set(identities).size).toBe(identities.length);
    for (const entry of CLI_EVALUATION_INPUT_REGISTRY) {
      expect(entry.normalizedField).not.toBe('');
      expect(entry.precedence).toBe(entry.sourceKind === 'cli-flag' ? 300 : 200);
      expect(entry.defaultSource).toBeTruthy();
      expect(entry.owner).toBeTruthy();
      expect(entry.digestStage).toBeTruthy();
      expect(entry.runtimeQualificationRequirements).toBeInstanceOf(Array);
      expect(entry.invalidCombinations).toBeInstanceOf(Array);
      expect(entry.errorCode).toMatch(/^CLI_INPUT_/);
      expect(entry.migration.migrationKind).toMatch(/^(retain|rename|remove)$/);
    }
  });

  it('records normalized defaults for inverse boolean flags', () => {
    const defaults = new Map(CLI_EVALUATION_INPUT_REGISTRY
      .filter((entry) => entry.sourceKind === 'cli-flag')
      .map((entry) => [entry.sourceKey, entry.defaultValue]));
    expect(defaults.get('no-judge')).toBe(true);
    expect(defaults.get('no-cache')).toBe('enabled');
    expect(defaults.get('no-serve')).toBe(true);
    expect(defaults.get('no-debias-length')).toBe(true);
    expect(defaults.get('no-diagnostic')).toBe('enabled-outside-core');
    expect(defaults.get('no-evidence')).toBe('append');
    expect(defaults.get('report-only')).toBe('gate');
  });
});
