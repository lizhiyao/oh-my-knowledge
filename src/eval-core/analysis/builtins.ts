/**
 * 内建分析入口：只留五个公开工厂与转口，实现按族分住 builtin-* 模块。
 *
 * 实现按族分住 builtin-* 模块；本入口只留公开工厂与转口，公开名与拆分前逐字一致。
 */
import { compareStrings } from '../primitives/ordering.js';
import { z } from 'zod';
import {
  schemaIdentityKey,
  type CoreSchemaValidator,
  type CoreSchemaValidationContext,
  type JsonValue,
  type SchemaIdentity,
} from '../contracts/index.js';
import type {
  AnalysisRuntimeRequirement,
  RuntimeResolution,} from '../compiler/index.js';
import type {
  AnalysisNodeImplementation,
} from './types.js';
import type {
  CompositeBootstrapParameters,
} from './builtin-composite.js';
import {
  BUILTIN_EXCLUDE_MISSING_POLICY,
  BUILTIN_FAMILY_RELEASE_DECISION_POLICY,
  BUILTIN_INTERVAL_PROGRESS_DECISION_POLICY,
  BUILTIN_PROGRESS_DECISION_POLICY,
} from './builtin-decisions.js';
import {
  BUILTIN_HYPOTHESIS_INPUT_SCHEMA,
  BUILTIN_HYPOTHESIS_TABLE_SCHEMA,
  HypothesisInputEnvelopeSchema,
  HypothesisTableEnvelopeSchema,
} from './builtin-hypothesis.js';
import {
  BUILTIN_DEFINITIONS,
} from './builtin-registry.js';
import {
  BONFERRONI_PARAMETERS_SCHEMA,
  BOOTSTRAP_PARAMETERS_SCHEMA,
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  BUILTIN_SCALAR_RESULT_SCHEMA,
  BUILTIN_SIMULTANEOUS_INTERVAL_FAMILY_RESULT_SCHEMA,
  BonferroniParametersSchema,
  BootstrapParametersSchema,
  COMPOSITE_BOOTSTRAP_PARAMETERS_SCHEMA,
  CompositeBootstrapParametersSchema,
  EMPTY_PARAMETERS_SCHEMA,
  FAMILY_RELEASE_PARAMETERS_SCHEMA,
  FamilyReleaseParametersSchema,
  HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA,
  HIERARCHICAL_QUANTILE_PARAMETERS_SCHEMA,
  HIERARCHICAL_REDUCER_PARAMETERS_SCHEMA,
  HierarchicalBootstrapParametersSchema,
  HierarchicalQuantileParametersSchema,
  HierarchicalReducerParametersSchema,
  IntervalEnvelopeSchema,
  PROGRESS_PARAMETERS_SCHEMA,
  ProgressParametersSchema,
  QUANTILE_PARAMETERS_SCHEMA,
  QuantileParametersSchema,
  SIMULTANEOUS_INTERVAL_FAMILY_PARAMETERS_SCHEMA,
  ScalarEnvelopeSchema,
  SimultaneousIntervalFamilyEnvelopeSchema,
  SimultaneousIntervalFamilyParametersSchema,
  StrictEmptyParametersSchema,
} from './builtin-schemas.js';
import {
  BuiltinNodeImplementation,
  BuiltinSchemaValidator,
  validateBonferroniContext,
  validateIntervalContext,
  validateSimultaneousIntervalFamilyContext,
} from './builtin-validation.js';
export {
  bonferroniMarginalAlpha,
  bonferroniMarginalConfidenceLevel,
} from '../contracts/statistics.js';


export {
  BUILTIN_EXCLUDE_MISSING_POLICY,
  BUILTIN_FAMILY_RELEASE_DECISION_POLICY,
  BUILTIN_INTERVAL_PROGRESS_DECISION_POLICY,
  BUILTIN_PROGRESS_DECISION_POLICY,
} from './builtin-decisions.js';
export {
  BUILTIN_HYPOTHESIS_INPUT_SCHEMA,
  BUILTIN_HYPOTHESIS_TABLE_SCHEMA,
} from './builtin-hypothesis.js';
export {
  BUILTIN_INTERVAL_RESULT_SCHEMA,
  BUILTIN_SCALAR_RESULT_SCHEMA,
  BUILTIN_SIMULTANEOUS_INTERVAL_FAMILY_RESULT_SCHEMA,
} from './builtin-schemas.js';

export function createBuiltinAnalysisNodes(): ReadonlyMap<string, AnalysisNodeImplementation> {
  return new Map([...BUILTIN_DEFINITIONS.entries()].map(([implementationId, definition]) => [
    implementationId,
    new BuiltinNodeImplementation(definition),
  ]));
}


export function createBuiltinAnalysisSchemaValidators(): ReadonlyMap<string, CoreSchemaValidator> {
  const validators = new Map<string, CoreSchemaValidator>();
  const entries: Array<[
    SchemaIdentity,
    z.ZodType,
    ((value: JsonValue, context?: Readonly<CoreSchemaValidationContext>) => void)?,
    ((value: JsonValue) => JsonValue)?,
  ]> = [
    [BUILTIN_SCALAR_RESULT_SCHEMA, ScalarEnvelopeSchema],
    [BUILTIN_INTERVAL_RESULT_SCHEMA, IntervalEnvelopeSchema, validateIntervalContext],
    [
      BUILTIN_SIMULTANEOUS_INTERVAL_FAMILY_RESULT_SCHEMA,
      SimultaneousIntervalFamilyEnvelopeSchema,
      validateSimultaneousIntervalFamilyContext,
    ],
    [BUILTIN_HYPOTHESIS_INPUT_SCHEMA, HypothesisInputEnvelopeSchema],
    [BUILTIN_HYPOTHESIS_TABLE_SCHEMA, HypothesisTableEnvelopeSchema, validateBonferroniContext],
    [EMPTY_PARAMETERS_SCHEMA, StrictEmptyParametersSchema],
    [QUANTILE_PARAMETERS_SCHEMA, QuantileParametersSchema],
    [BOOTSTRAP_PARAMETERS_SCHEMA, BootstrapParametersSchema],
    [HIERARCHICAL_BOOTSTRAP_PARAMETERS_SCHEMA, HierarchicalBootstrapParametersSchema],
    [HIERARCHICAL_REDUCER_PARAMETERS_SCHEMA, HierarchicalReducerParametersSchema],
    [HIERARCHICAL_QUANTILE_PARAMETERS_SCHEMA, HierarchicalQuantileParametersSchema],
    [
      COMPOSITE_BOOTSTRAP_PARAMETERS_SCHEMA,
      CompositeBootstrapParametersSchema,
      undefined,
      (value) => {
        const parsed = value as CompositeBootstrapParameters;
        return {
          ...parsed,
          components: [...parsed.components].sort((left, right) => (
            compareStrings(left.metricId, right.metricId)
          )),
        };
      },
    ],
    [BONFERRONI_PARAMETERS_SCHEMA, BonferroniParametersSchema],
    [
      SIMULTANEOUS_INTERVAL_FAMILY_PARAMETERS_SCHEMA,
      SimultaneousIntervalFamilyParametersSchema,
    ],
    [PROGRESS_PARAMETERS_SCHEMA, ProgressParametersSchema],
    [
      FAMILY_RELEASE_PARAMETERS_SCHEMA,
      FamilyReleaseParametersSchema,
      undefined,
      (value) => {
        const parsed = value as z.infer<typeof FamilyReleaseParametersSchema>;
        return {
          ...parsed,
          criteria: [...parsed.criteria].sort((left, right) => (
            compareStrings(left.analysisResultId, right.analysisResultId)
          )),
        };
      },
    ],
  ];
  for (const [schema, zodSchema, validateContext, normalize] of entries) {
    validators.set(
      schemaIdentityKey(schema),
      new BuiltinSchemaValidator(schema, zodSchema, validateContext, normalize),
    );
  }
  return validators;
}


export function createBuiltinMissingPolicies() {
  return new Map([['exclude/v1', BUILTIN_EXCLUDE_MISSING_POLICY]]);
}


export function createBuiltinDecisionPolicies() {
  return new Map([
    ['progress/v1', BUILTIN_PROGRESS_DECISION_POLICY],
    ['progress/v2', BUILTIN_INTERVAL_PROGRESS_DECISION_POLICY],
    ['release-family/v1', BUILTIN_FAMILY_RELEASE_DECISION_POLICY],
  ]);
}


export function resolveBuiltinAnalysisRuntime(
  requirement: Readonly<AnalysisRuntimeRequirement>,
): RuntimeResolution | undefined {
  if (requirement.requirementKind === 'missing-policy') {
    if (requirement.implementationId !== 'exclude/v1') return undefined;
    return {
      identity: BUILTIN_EXCLUDE_MISSING_POLICY.identity,
      satisfiesVersionConstraint: true,
    };
  }
  if (requirement.requirementKind === 'decision-policy') {
    const policy = requirement.implementationId === 'progress/v1'
      ? BUILTIN_PROGRESS_DECISION_POLICY
      : requirement.implementationId === 'progress/v2'
        ? BUILTIN_INTERVAL_PROGRESS_DECISION_POLICY
        : requirement.implementationId === 'release-family/v1'
          ? BUILTIN_FAMILY_RELEASE_DECISION_POLICY
          : undefined;
    if (policy === undefined) return undefined;
    return {
      identity: policy.identity,
      satisfiesVersionConstraint: true,
    };
  }
  const definition = BUILTIN_DEFINITIONS.get(requirement.implementationId);
  if (definition === undefined) return undefined;
  return { identity: definition.identity, satisfiesVersionConstraint: true };
}

