import type { JsonValue } from './contracts/json.js';
import { deepFreezeCanonicalJson } from './contracts/json.js';
import type { RunPlan } from './contracts/plans.js';

export type DeepReadonly<T> = T extends JsonValue
  ? T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

declare const sealedRunPlanBrand: unique symbol;

export type SealedRunPlan = DeepReadonly<RunPlan> & {
  readonly [sealedRunPlanBrand]: true;
};

const sealedRunPlans = new WeakSet<object>();

export function sealRunPlan(plan: RunPlan): SealedRunPlan {
  const sealed = deepFreezeCanonicalJson(structuredClone(plan)) as unknown as SealedRunPlan;
  sealedRunPlans.add(sealed);
  return sealed;
}

export function assertSealedRunPlan(value: unknown): asserts value is SealedRunPlan {
  if (value === null || typeof value !== 'object' || !sealedRunPlans.has(value)) {
    throw new TypeError(
      'Evaluation Core requires a sealed RunPlan returned by prepareEvaluationPlan().',
    );
  }
}
