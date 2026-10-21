import { ANALYSIS_PLAN_SCHEMA_VERSION, DECISION_PLAN_SCHEMA_VERSION, EVALUATION_PLAN_SCHEMA_VERSION, EXECUTION_PLAN_SCHEMA_VERSION, MeasurementPolicySchema, RUN_PLAN_SCHEMA_VERSION, RunPlanSchema, computePlanDigests, deriveSchedulingTargetGroups, generateRunContractSchemaIdentities, parseWireDocument, projectExecutionExperimentDesign, deriveAssignmentMemberships, projectEvaluationInputs, projectAnalysisInputs, projectAnalysisCohorts, projectExecutionInputs, type SchemaIdentity } from '../contracts/index.js';
import { EvaluationDefinitionError } from './errors.js';
import { type PreparationRuntime, type SealedRunPlan } from './types.js';
import { validateDefinitionSemantics, validateMaterializedAnalysisSemantics, validateMaterializedDecisionSemantics } from './validation.js';
import { sealRunPlan } from '../contracts/sealed-run-plan.js';
import { parseInput, addSchemaIdentity, sortSchemaIdentities } from './preparation/schemas.js';
import { resolveExecutors, resolveEvaluators, resolveAnalysisRuntimes, resolveDecisionRuntimes } from './preparation/runtimes.js';
import { normalizeDefinitionParameters, normalizeEvaluationDefinition } from './preparation/definition.js';
import { resolveExtensions } from './preparation/extensions.js';
export * from './errors.js';
export * from './types.js';
export { assertSealedRunPlan } from '../contracts/sealed-run-plan.js';
export {
  validateDefinitionSemantics,
  validateMaterializedAnalysisSemantics,
  validateMaterializedDecisionSemantics,
} from './validation.js';
export { normalizeEvaluationDefinition } from './preparation/definition.js';

export async function prepareEvaluationPlan(
  definitionInput: unknown,
  measurementPolicyInput: unknown,
  runtime: PreparationRuntime,
): Promise<SealedRunPlan> {
  let definition = normalizeEvaluationDefinition(definitionInput);
  const measurementPolicy = parseInput(
    MeasurementPolicySchema,
    measurementPolicyInput,
    'MeasurementPolicy',
  );
  validateDefinitionSemantics(definition, measurementPolicy);

  const identitiesByUri = new Map<string, SchemaIdentity>();
  for (const identity of generateRunContractSchemaIdentities()) {
    addSchemaIdentity(identitiesByUri, identity, identity.schemaVersion);
  }
  const executorRuntimes = await resolveExecutors(
    definition,
    measurementPolicy,
    runtime,
    identitiesByUri,
  );
  const evaluatorRuntimes = await resolveEvaluators(definition, runtime, identitiesByUri);
  const analysisRuntimes = await resolveAnalysisRuntimes(definition, runtime, identitiesByUri);
  const decisionRuntimes = await resolveDecisionRuntimes(
    definition,
    runtime,
    analysisRuntimes,
    identitiesByUri,
  );
  definition = normalizeDefinitionParameters(
    definition,
    analysisRuntimes,
    decisionRuntimes,
    runtime,
  );
  validateMaterializedAnalysisSemantics(definition);
  if (definition.decisionPolicy?.implementationId === 'release-family/v1') {
    validateMaterializedDecisionSemantics(definition);
  }
  const stageExtensions = await resolveExtensions(
    definition.extensions,
    measurementPolicy.extensions,
    runtime,
  );
  const schemaIdentities = sortSchemaIdentities(identitiesByUri);
  const schedulingTargetGroups = deriveSchedulingTargetGroups({
    targetIds: definition.targets.map((target) => target.targetId),
    comparisons: definition.comparisons,
    paired: definition.experiment.sampling.resamplingUnit === 'paired-block',
  });
  const executionSamples = projectExecutionInputs(definition.dataset);
  const assignments = deriveAssignmentMemberships({
    samples: executionSamples,
    experiment: definition.experiment,
  });
  const digests = computePlanDigests({
    dataset: definition.dataset,
    targets: definition.targets,
    evaluators: definition.evaluators,
    metrics: definition.metrics,
    experiment: definition.experiment,
    analysisGraph: definition.analysisGraph,
    comparisons: definition.comparisons,
    ...(definition.decisionPolicy !== undefined
      ? { decisionPolicy: definition.decisionPolicy }
      : {}),
    measurementPolicy,
    executorRuntimes,
    evaluatorRuntimes,
    analysisRuntimes,
    decisionRuntimes,
    schemaIdentities,
    ...(definition.seriesMembership !== undefined
      ? { seriesMembership: definition.seriesMembership }
      : {}),
    stageExtensions,
  });

  const execution = {
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    executionInputDigest: digests.executionInputDigest,
    randomizationDesignDigest: digests.randomizationDesignDigest,
    samples: executionSamples,
    targets: definition.targets,
    assignments,
    schedulingTargetGroups,
    experiment: projectExecutionExperimentDesign(definition.experiment),
    runtimes: executorRuntimes,
    policy: {
      execution: measurementPolicy.execution,
      retry: measurementPolicy.retry,
      budget: measurementPolicy.budget,
      executionCacheMode: measurementPolicy.cache.executionMode,
      evidence: {
        output: measurementPolicy.evidence.output,
        trace: measurementPolicy.evidence.trace,
        maximumClassification: measurementPolicy.evidence.maximumClassification,
      },
      failure: measurementPolicy.failure,
    },
    executionPlanDigest: digests.executionPlanDigest,
    ...(stageExtensions.execution !== undefined
      ? { extensions: stageExtensions.execution }
      : {}),
  };
  const evaluation = {
    schemaVersion: EVALUATION_PLAN_SCHEMA_VERSION,
    executionPlanDigest: digests.executionPlanDigest,
    evaluationInputDigest: digests.evaluationInputDigest,
    samples: projectEvaluationInputs(definition.dataset),
    evaluators: definition.evaluators,
    metrics: definition.metrics,
    runtimes: evaluatorRuntimes,
    policy: {
      runtime: measurementPolicy.evaluation,
      budget: measurementPolicy.budget,
      evaluationCacheMode: measurementPolicy.cache.evaluationMode,
      evidence: measurementPolicy.evidence,
      failure: measurementPolicy.failure,
    },
    evaluationPlanDigest: digests.evaluationPlanDigest,
    ...(stageExtensions.evaluation !== undefined
      ? { extensions: stageExtensions.evaluation }
      : {}),
  };
  const analysis = {
    schemaVersion: ANALYSIS_PLAN_SCHEMA_VERSION,
    evaluationPlanDigest: digests.evaluationPlanDigest,
    analysisInputDigest: digests.analysisInputDigest,
    samples: projectAnalysisInputs(definition.dataset),
    cohorts: projectAnalysisCohorts(definition.dataset),
    metrics: definition.metrics,
    analysisGraph: definition.analysisGraph,
    experiment: definition.experiment,
    comparisons: definition.comparisons,
    runtimes: analysisRuntimes,
    analysisPlanDigest: digests.analysisPlanDigest,
    ...(stageExtensions.analysis !== undefined
      ? { extensions: stageExtensions.analysis }
      : {}),
  };
  const decision = {
    schemaVersion: DECISION_PLAN_SCHEMA_VERSION,
    analysisPlanDigest: digests.analysisPlanDigest,
    analysisInputDigest: digests.analysisInputDigest,
    ...(definition.decisionPolicy !== undefined
      ? { decisionPolicy: definition.decisionPolicy }
      : {}),
    runtimes: decisionRuntimes,
    decisionPlanDigest: digests.decisionPlanDigest,
    ...(stageExtensions.decision !== undefined
      ? { extensions: stageExtensions.decision }
      : {}),
  };
  const plan = {
    schemaVersion: RUN_PLAN_SCHEMA_VERSION,
    definition,
    measurementPolicy,
    execution,
    evaluation,
    analysis,
    decision,
    schemaIdentities,
    digests,
    ...(stageExtensions.run !== undefined ? { extensions: stageExtensions.run } : {}),
  };

  try {
    const parsed = parseWireDocument(RunPlanSchema, plan);
    return sealRunPlan(parsed);
  } catch {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_SCHEMA_INVALID',
      stage: 'internal',
      preparationStage: 'sealing',
      message: 'Compiler 生成的 RunPlan 未通过内部契约校验。',
    });
  }
}
