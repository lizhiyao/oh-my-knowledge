import {
  JsonValueSchema,
  deepFreezeCanonicalJson,
  type EvaluatorDefinition,
  type JsonValue,
  type MetricDefinition,
} from '../../eval-core/contracts/index.js';
import type { EvaluationEvaluator } from '../../eval-core/evaluation/index.js';
import type { EvaluatorRuntimeRequirement } from '../../eval-core/compiler/index.js';
import type { RuntimePortRegistration } from '../runtime.js';
import type {
  OmkLlmJudgeEffort,
  OmkLlmJudgeInvocationPort,
} from './invocation.js';
import { captureLlmJudgeInvocationPort } from './invocation.js';
import {
  createRubricJudgeCriterion,
  createRubricJudgeEvaluatorDefinition,
  createRubricJudgeEvaluatorRegistration,
  createRubricJudgeInstrument,
  createRubricJudgeMetricDefinition,
  createRubricJudgeRuntimeConfig,
  type RubricJudgeCriterion,
  type RubricJudgeEvaluatorBinding,
  type RubricJudgeInstrument,
  type RubricJudgeRuntimeConfig,
  type RubricJudgeTracePolicy,
} from './rubric-judge.js';

export interface CreateRubricJudgeKitInput {
  readonly evaluatorId: string;
  readonly metricId: string;
  readonly evaluatorVersionConstraint?: string;
  readonly satisfiesEvaluatorVersionConstraint?: (constraint: string) => boolean;
  readonly model: string;
  readonly invocation: OmkLlmJudgeInvocationPort;
  readonly effort?: OmkLlmJudgeEffort;
  readonly lengthDebias?: boolean;
  readonly tracePolicy?: RubricJudgeTracePolicy;
  readonly actualPointer?: string;
  readonly tracePointer?: string;
  readonly applicableSampleIds?: readonly string[];
  readonly ensembleMemberId?: string;
  readonly replicateGroupId?: string;
  readonly replicateIndex?: number;
  readonly classification?: 'public' | 'sensitive';
}

export interface RubricJudgeKit {
  readonly instrument: RubricJudgeInstrument;
  readonly runtime: RubricJudgeRuntimeConfig;
  readonly evaluatorDefinition: EvaluatorDefinition;
  readonly metricDefinition: MetricDefinition;
  /** Ready-to-use registration for the common single-evaluator case. */
  readonly evaluatorRegistration: RuntimePortRegistration<
    EvaluationEvaluator,
    EvaluatorRuntimeRequirement
  >;
  createCriterion(
    input: Readonly<{
      criterionId: string;
      prompt: string;
      rubric: string;
    }>,
  ): RubricJudgeCriterion;
  createEvaluationContext(
    criterion: Readonly<RubricJudgeCriterion>,
    base?: Readonly<{ [key: string]: JsonValue }>,
  ): JsonValue;
}

interface RubricJudgeKitBinding {
  readonly evaluatorId: string;
  readonly evaluatorBinding: Readonly<RubricJudgeEvaluatorBinding>;
  readonly satisfiesVersionConstraint?: (constraint: string) => boolean;
}

const kitBindings = new WeakMap<object, RubricJudgeKitBinding>();

function pointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function capturedCriterion(criterion: Readonly<RubricJudgeCriterion>): RubricJudgeCriterion {
  return createRubricJudgeCriterion({
    criterionId: criterion.criterionId,
    prompt: criterion.prompt,
    rubric: criterion.rubric,
  });
}

function evaluationContext(
  entries: readonly Readonly<{
    evaluatorId: string;
    criterion: Readonly<RubricJudgeCriterion>;
  }>[],
  base: Readonly<{ [key: string]: JsonValue }>,
): JsonValue {
  const capturedBase = JsonValueSchema.parse(structuredClone(base));
  if (capturedBase === null || Array.isArray(capturedBase) || typeof capturedBase !== 'object') {
    throw new TypeError('Rubric judge base evaluation context must be a JSON object.');
  }
  if (capturedBase.rubricJudge !== undefined) {
    throw new TypeError('Rubric judge base evaluation context already contains rubricJudge.');
  }
  const criteria = new Map<string, JsonValue>();
  for (const entry of entries) {
    if (criteria.has(entry.evaluatorId)) {
      throw new TypeError(`Rubric judge evaluatorId is duplicated: "${entry.evaluatorId}".`);
    }
    criteria.set(entry.evaluatorId, capturedCriterion(entry.criterion));
  }
  return deepFreezeCanonicalJson({
    ...capturedBase,
    rubricJudge: Object.fromEntries(criteria),
  });
}

function registration<ResourceLease>(
  evaluatorBindings: readonly Readonly<RubricJudgeEvaluatorBinding<ResourceLease>>[],
  versionChecks: readonly ((constraint: string) => boolean)[],
): RuntimePortRegistration<EvaluationEvaluator, EvaluatorRuntimeRequirement> {
  const base = createRubricJudgeEvaluatorRegistration(evaluatorBindings);
  return Object.freeze({
    ...base,
    ...(versionChecks.length === 0 ? {} : {
      satisfiesVersionConstraint: (constraint: string) => (
        versionChecks.every((candidate) => candidate(constraint))
      ),
    }),
  });
}

/** Creates mutually consistent Core fragments and Runtime wiring from one frozen Judge setup. */
export function createRubricJudgeKit(
  input: Readonly<CreateRubricJudgeKitInput>,
): RubricJudgeKit {
  const invocation = captureLlmJudgeInvocationPort(input.invocation);
  const evaluatorId = input.evaluatorId;
  const instrument = createRubricJudgeInstrument({
    ...(input.lengthDebias === undefined ? {} : { lengthDebias: input.lengthDebias }),
    ...(input.tracePolicy === undefined ? {} : { tracePolicy: input.tracePolicy }),
  });
  const runtime = createRubricJudgeRuntimeConfig({
    executorId: invocation.identity.implementationId,
    model: input.model,
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    instrument,
  });
  const evaluatorDefinition = createRubricJudgeEvaluatorDefinition({
    evaluatorId,
    metricId: input.metricId,
    ...(input.evaluatorVersionConstraint === undefined
      ? {}
      : { versionConstraint: input.evaluatorVersionConstraint }),
    instrument,
    runtime,
    ...(input.actualPointer === undefined ? {} : { actualPointer: input.actualPointer }),
    criterionPointer: `/rubricJudge/${pointerToken(evaluatorId)}`,
    ...(input.tracePointer === undefined ? {} : { tracePointer: input.tracePointer }),
    ...(input.applicableSampleIds === undefined
      ? {}
      : { applicableSampleIds: input.applicableSampleIds }),
    ...(input.ensembleMemberId === undefined
      ? {}
      : { ensembleMemberId: input.ensembleMemberId }),
    ...(input.replicateGroupId === undefined
      ? {}
      : { replicateGroupId: input.replicateGroupId }),
    ...(input.replicateIndex === undefined ? {} : { replicateIndex: input.replicateIndex }),
    ...(input.classification === undefined ? {} : { classification: input.classification }),
  });
  const metricDefinition = createRubricJudgeMetricDefinition(input.metricId);
  const evaluatorBinding: Readonly<RubricJudgeEvaluatorBinding> = Object.freeze({
    evaluatorId,
    instrument,
    runtime,
    invocation,
  });
  const versionChecks = input.satisfiesEvaluatorVersionConstraint === undefined
    ? []
    : [input.satisfiesEvaluatorVersionConstraint];
  const evaluatorRegistration = registration([evaluatorBinding], versionChecks);

  const kit: RubricJudgeKit = Object.freeze({
    instrument,
    runtime,
    evaluatorDefinition,
    metricDefinition,
    evaluatorRegistration,
    createCriterion: createRubricJudgeCriterion,
    createEvaluationContext: (
      criterion: Readonly<RubricJudgeCriterion>,
      base?: Readonly<{ [key: string]: JsonValue }>,
    ) => (
      evaluationContext([{ evaluatorId, criterion }], base ?? {})
    ),
  });
  kitBindings.set(kit, {
    evaluatorId,
    evaluatorBinding,
    ...(input.satisfiesEvaluatorVersionConstraint === undefined
      ? {}
      : { satisfiesVersionConstraint: input.satisfiesEvaluatorVersionConstraint }),
  });
  return kit;
}

/** Builds the exact evaluationContext shape sealed by one or more Rubric kits. */
export function createRubricJudgeEvaluationContext(
  entries: readonly Readonly<{
    kit: Readonly<RubricJudgeKit>;
    criterion: Readonly<RubricJudgeCriterion>;
  }>[],
  base: Readonly<{ [key: string]: JsonValue }> = {},
): JsonValue {
  if (entries.length === 0) {
    throw new TypeError('Rubric judge evaluation context requires at least one kit.');
  }
  const capturedEntries = entries.map((entry) => {
    const binding = kitBindings.get(entry.kit);
    if (binding === undefined) {
      throw new TypeError('Rubric judge evaluation context only accepts kits from this package.');
    }
    return { evaluatorId: binding.evaluatorId, criterion: entry.criterion };
  });
  return evaluationContext(capturedEntries, base);
}

/** Combines multiple kits that share the built-in Judge implementation into one registration. */
export function createRubricJudgeRegistration(
  kits: readonly Readonly<RubricJudgeKit>[],
): RuntimePortRegistration<EvaluationEvaluator, EvaluatorRuntimeRequirement> {
  if (kits.length === 0) {
    throw new TypeError('Rubric judge registration requires at least one kit.');
  }
  const bindings = kits.map((kit) => {
    const binding = kitBindings.get(kit);
    if (binding === undefined) {
      throw new TypeError('Rubric judge registration only accepts kits created by this package.');
    }
    return binding;
  });
  return registration(
    bindings.map((binding) => binding.evaluatorBinding),
    bindings.flatMap((binding) => (
      binding.satisfiesVersionConstraint === undefined
        ? []
        : [binding.satisfiesVersionConstraint]
    )),
  );
}
