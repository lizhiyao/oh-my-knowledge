import type { EvalBudget, EvalConfig, EvalConfigVariant } from '../../../src/inputs/contracts/config.js';
import type { RemoteGitRef } from '../../../src/inputs/contracts/variant.js';
import type { JudgeConfig } from '../../../src/grading/contracts/config.js';
import { EVAL_CONFIG_SCHEMA_SOURCE_PATHS } from '../../../src/inputs/eval-config.js';

type SchemaPath = typeof EVAL_CONFIG_SCHEMA_SOURCE_PATHS[number];
type Root<Path extends string> = Path extends `${infer Name}[].${string}`
  ? Name
  : Path extends `${infer Name}.${string}`
    ? Name
    : Path;
type ChildRoot<Path extends string, Prefix extends string> =
  Path extends `${Prefix}${infer Rest}`
    ? Rest extends `${infer Name}.${string}` ? Name : Rest
    : never;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
        (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Assert<Value extends true> = Value;

/** Typecheck fails when EvalConfig gains a field without extending the registry surface. */
export type EvalConfigSchemaSurfaceIsExhaustive = [
  Assert<Equal<keyof EvalConfig, Root<SchemaPath>>>,
  Assert<Equal<
    keyof EvalConfigVariant,
    ChildRoot<Extract<SchemaPath, `variants[].${string}`>, 'variants[].'>
  >>,
  Assert<Equal<
    keyof RemoteGitRef,
    ChildRoot<Extract<SchemaPath, `variants[].git.${string}`>, 'variants[].git.'>
  >>,
  Assert<Equal<
    keyof EvalBudget,
    ChildRoot<Extract<SchemaPath, `budget.${string}`>, 'budget.'>
  >>,
  Assert<Equal<
    keyof JudgeConfig,
    ChildRoot<Extract<SchemaPath, `judgeModels[].${string}`>, 'judgeModels[].'>
  >>,
];
