import {
  EVALUATION_DEFINITION_SCHEMA_VERSION,
  EvaluationDefinitionSchema,
  EvaluatorDefinitionSchema,
  MetricDefinitionSchema,
  TargetDefinitionSchema,
  deepFreezeCanonicalJson,
  type EvaluationDefinition,
  type EvaluationSample,
  type EvaluatorDefinition,
  type JsonValue,
  type MetricDefinition,
  type TargetDefinition,
  type TargetExecutionControls,
  type TargetExecutionRequirements,
} from '../../eval-core/contracts/index.js';

export interface EvaluationRuntimeTarget {
  readonly targetId: string;
  readonly executorId: string;
  readonly targetKind?: string;
  readonly protocolId?: 'omk.invoke/v1' | 'omk.session/v1';
  readonly versionConstraint?: string;
  readonly config?: JsonValue;
  readonly executionRequirements?: TargetExecutionRequirements;
  readonly executionControls?: TargetExecutionControls;
}

export interface PairedComparisonDefinitionBuilderInput {
  readonly datasetId: string;
  readonly samples: readonly EvaluationSample[];
  readonly control: EvaluationRuntimeTarget;
  readonly treatment: EvaluationRuntimeTarget;
  readonly evaluator: EvaluatorDefinition;
  readonly metric: MetricDefinition;
  /** Required measurement seed; never sourced from time, environment, or randomness. */
  readonly seed: string;
  readonly trials?: number;
  readonly bootstrap?: Readonly<{ resamples?: number; alpha?: number }>;
  readonly decision?: Readonly<{
    threshold?: number;
    equivalence?: number;
    minimumEvidenceStatus?: 'complete' | 'partial' | 'unresolvable';
  }>;
  readonly identities?: Readonly<{
    comparisonId?: string;
    analysisNodeId?: string;
    analysisResultId?: string;
    decisionPolicyId?: string;
  }>;
}

function target(input: Readonly<EvaluationRuntimeTarget>): TargetDefinition {
  return TargetDefinitionSchema.parse({
    targetId: input.targetId,
    targetKind: input.targetKind ?? 'function',
    protocolId: input.protocolId ?? 'omk.invoke/v1',
    executorId: input.executorId,
    ...(input.versionConstraint === undefined
      ? {}
      : { versionConstraint: input.versionConstraint }),
    executionRequirements: input.executionRequirements ?? {
      systemInstructions: 'not-required',
      workspace: 'not-required',
      mcp: 'not-required',
      mockInterception: 'not-required',
      toolPolicy: 'runtime-default',
      skillDiscovery: 'runtime-default',
    },
    executionControls: input.executionControls ?? {
      defaults: {
        workspace: { workspaceMode: 'not-required' },
        tools: { toolPolicyKind: 'runtime-default' },
      },
      sampleOverrides: [],
    },
    ...(input.config === undefined ? {} : { config: structuredClone(input.config) }),
  });
}

/**
 * Builds one auditable control/treatment comparison for function, service, or RAG Targets.
 * The result is the ordinary Core wire contract; every convenience default is materialized.
 */
export function createPairedComparisonDefinition(
  input: Readonly<PairedComparisonDefinitionBuilderInput>,
): EvaluationDefinition {
  const evaluator = EvaluatorDefinitionSchema.parse(structuredClone(input.evaluator));
  const metric = MetricDefinitionSchema.parse(structuredClone(input.metric));
  if (evaluator.metricIds.length !== 1 || evaluator.metricIds[0] !== metric.metricId) {
    throw new TypeError('Paired comparison requires one Evaluator metric matching metric.metricId.');
  }
  if (!['numeric', 'boolean'].includes(metric.valueType)
      || metric.direction !== 'higher-is-better'
      || metric.missingPolicyId !== 'exclude/v1') {
    throw new TypeError(
      'Paired comparison requires a higher-is-better numeric or boolean metric using exclude/v1.',
    );
  }
  const control = target(input.control);
  const treatment = target(input.treatment);
  if (control.targetId === treatment.targetId) {
    throw new TypeError('Paired comparison control and treatment targetId must differ.');
  }
  const targets = [control, treatment];
  const metricId = metric.metricId;
  const comparisonId = input.identities?.comparisonId ?? 'control-vs-treatment';
  const analysisNodeId = input.identities?.analysisNodeId ?? `paired-${metricId}-bootstrap`;
  const analysisResultId = input.identities?.analysisResultId ?? `paired-${metricId}-difference`;
  const decisionPolicyId = input.identities?.decisionPolicyId ?? 'progress-decision';
  const trials = input.trials ?? 1;
  const definition = EvaluationDefinitionSchema.parse({
    schemaVersion: EVALUATION_DEFINITION_SCHEMA_VERSION,
    dataset: {
      datasetId: input.datasetId,
      samples: structuredClone(input.samples),
    },
    targets,
    evaluators: [evaluator],
    metrics: [metric],
    experiment: {
      trials,
      seed: input.seed,
      assignment: {
        assignmentKind: 'complete-block',
        algorithmId: 'assignment.complete-block/v1',
        randomizationSlotIds: targets.map((candidate) => `slot-${candidate.targetId}`).sort(),
      },
      randomizationSlots: targets.map((candidate) => ({
        targetId: candidate.targetId,
        randomizationSlotId: `slot-${candidate.targetId}`,
      })).sort((left, right) => (
        left.randomizationSlotId < right.randomizationSlotId ? -1
          : left.randomizationSlotId > right.randomizationSlotId ? 1 : 0
      )),
      sampling: {
        experimentalUnit: 'sample',
        pairingKey: '/sampleId',
        repeatedMeasures: trials > 1,
        resamplingUnit: 'paired-block',
        estimatorId: 'bootstrap.paired-difference-percentile/v1',
        seedCoupling: 'shared-within-block',
      },
      scheduling: { schedulingKind: 'interleaved' },
    },
    analysisGraph: {
      analysisMode: 'preregistered',
      nodes: [{
        analysisNodeKind: 'estimator',
        nodeId: analysisNodeId,
        implementationId: 'bootstrap.paired-difference-percentile/v1',
        inputs: [
          { inputKind: 'metric-observations', referenceId: metricId },
          {
            inputKind: 'comparison',
            referenceId: comparisonId,
            treatmentTargetId: treatment.targetId,
            metricId,
          },
        ],
        outputResultId: analysisResultId,
        parameters: {
          resamples: input.bootstrap?.resamples ?? 1_000,
          alpha: input.bootstrap?.alpha ?? 0.05,
        },
      }],
    },
    comparisons: [{
      comparisonId,
      controlTargetId: control.targetId,
      treatmentTargetIds: [treatment.targetId],
      metricIds: [metricId],
    }],
    decisionPolicy: {
      decisionPolicyId,
      implementationId: 'progress/v2',
      analysisResultIds: [analysisResultId],
      minimumEvidenceStatus: input.decision?.minimumEvidenceStatus ?? 'complete',
      parameters: {
        threshold: input.decision?.threshold ?? 0,
        equivalence: input.decision?.equivalence ?? 0,
      },
    },
  });
  return deepFreezeCanonicalJson(definition);
}
