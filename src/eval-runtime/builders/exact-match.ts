import {
  EVALUATION_DEFINITION_SCHEMA_VERSION,
  EvaluationDefinitionSchema,
  deepFreezeCanonicalJson,
  type EvaluationDefinition,
  type EvaluationSample,
  type JsonValue,
} from '../../eval-core/contracts/index.js';
import { EXACT_MATCH_EVALUATOR_IMPLEMENTATION_ID } from '../evaluators/exact-match.js';

export interface ExactMatchTarget {
  readonly targetId: string;
  readonly executorId: string;
  readonly targetKind?: string;
  readonly config?: JsonValue;
}

export interface ExactMatchDefinitionBuilderInput {
  readonly datasetId: string;
  readonly samples: readonly EvaluationSample[];
  readonly control: ExactMatchTarget;
  readonly treatment: ExactMatchTarget;
  /** Required measurement seed; never sourced from time, environment, or randomness. */
  readonly seed: string;
  readonly trials?: number;
  readonly metricId?: string;
  readonly bootstrap?: Readonly<{ resamples?: number; alpha?: number }>;
  readonly decision?: Readonly<{
    threshold?: number;
    equivalence?: number;
    minimumEvidenceStatus?: 'complete' | 'partial' | 'unresolvable';
  }>;
}

/**
 * Builds a paired exact-match comparison without changing Core's measurement semantics.
 * The returned Definition is validated, deeply immutable, and JSON serializable.
 */
export function createExactMatchDefinition(
  input: Readonly<ExactMatchDefinitionBuilderInput>,
): EvaluationDefinition {
  const metricId = input.metricId ?? 'correct';
  const comparisonId = 'control-vs-treatment';
  const resultId = 'paired-correctness-difference';
  const targets = [input.control, input.treatment].map((target) => ({
    targetId: target.targetId,
    targetKind: target.targetKind ?? 'function',
    protocolId: 'omk.invoke/v1' as const,
    executorId: target.executorId,
    executionRequirements: {
      systemInstructions: 'not-required' as const,
      workspace: 'not-required' as const,
      mcp: 'not-required' as const,
      mockInterception: 'not-required' as const,
      toolPolicy: 'runtime-default' as const,
      skillDiscovery: 'runtime-default' as const,
    },
    executionControls: {
      defaults: {
        workspace: { workspaceMode: 'not-required' as const },
        tools: { toolPolicyKind: 'runtime-default' as const },
      },
      sampleOverrides: [],
    },
    ...(target.config === undefined ? {} : { config: structuredClone(target.config) }),
  }));
  const randomizationSlots = targets.map((target) => ({
    targetId: target.targetId,
    randomizationSlotId: `slot-${target.targetId}`,
  })).sort((left, right) => (
    left.randomizationSlotId < right.randomizationSlotId ? -1
      : left.randomizationSlotId > right.randomizationSlotId ? 1 : 0
  ));
  const definition = EvaluationDefinitionSchema.parse({
    schemaVersion: EVALUATION_DEFINITION_SCHEMA_VERSION,
    dataset: {
      datasetId: input.datasetId,
      samples: structuredClone(input.samples),
    },
    targets,
    evaluators: [{
      evaluatorId: 'exact-match',
      evaluatorKind: 'assertion',
      implementationId: EXACT_MATCH_EVALUATOR_IMPLEMENTATION_ID,
      measurement: {
        instrumentId: 'canonical-json-exact-match-v1',
        ensembleMemberId: 'deterministic-local',
        replicateGroupId: 'deterministic-primary',
        replicateIndex: 0,
      },
      metricIds: [metricId],
      inputs: [
        { bindingId: 'actual', sourceKind: 'output', pointer: '' },
        { bindingId: 'expected', sourceKind: 'expected', pointer: '' },
      ],
    }],
    metrics: [{
      metricId,
      valueType: 'boolean',
      scope: 'sample',
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    }],
    experiment: {
      trials: input.trials ?? 1,
      seed: input.seed,
      randomizationSlots,
      sampling: {
        experimentalUnit: 'sample',
        pairingKey: '/sampleId',
        repeatedMeasures: (input.trials ?? 1) > 1,
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
        nodeId: 'paired-correctness-bootstrap',
        implementationId: 'bootstrap.paired-difference-percentile/v1',
        inputs: [
          { inputKind: 'metric-observations', referenceId: metricId },
          {
            inputKind: 'comparison',
            referenceId: comparisonId,
            treatmentTargetId: input.treatment.targetId,
            metricId,
          },
        ],
        outputResultId: resultId,
        parameters: {
          resamples: input.bootstrap?.resamples ?? 1_000,
          alpha: input.bootstrap?.alpha ?? 0.05,
        },
      }],
    },
    comparisons: [{
      comparisonId,
      controlTargetId: input.control.targetId,
      treatmentTargetIds: [input.treatment.targetId],
      metricIds: [metricId],
    }],
    decisionPolicy: {
      decisionPolicyId: 'progress-decision',
      implementationId: 'progress/v1',
      analysisResultIds: [resultId],
      minimumEvidenceStatus: input.decision?.minimumEvidenceStatus ?? 'complete',
      parameters: {
        threshold: input.decision?.threshold ?? 0,
        equivalence: input.decision?.equivalence ?? 0,
      },
    },
  });
  return deepFreezeCanonicalJson(definition);
}
