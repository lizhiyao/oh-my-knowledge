import {
  type EvaluationDefinition,
  type EvaluationSample,
  type JsonValue,
} from '../../eval-core/contracts/index.js';
import { EXACT_MATCH_EVALUATOR_IMPLEMENTATION_ID } from '../evaluators/exact-match.js';
import { createPairedComparisonDefinition } from './paired-comparison.js';

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
  return createPairedComparisonDefinition({
    datasetId: input.datasetId,
    samples: input.samples,
    control: input.control,
    treatment: input.treatment,
    seed: input.seed,
    trials: input.trials,
    bootstrap: input.bootstrap,
    decision: input.decision,
    identities: {
      comparisonId: 'control-vs-treatment',
      analysisNodeId: 'paired-correctness-bootstrap',
      analysisResultId: 'paired-correctness-difference',
      decisionPolicyId: 'progress-decision',
    },
    evaluator: {
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
    },
    metric: {
      metricId,
      valueType: 'boolean',
      scope: 'sample',
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    },
  });
}
