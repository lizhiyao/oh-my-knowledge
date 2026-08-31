import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createEvaluationEngine,
  digestCanonicalJson,
  type EvaluationDefinition,
  type EvaluationEngineClock,
  type EvaluationEngineRuntime,
  type JsonValue,
  type MeasurementPolicy,
  type RuntimeIdentity,
  type UsageRecord,
} from '../../src/index.js';
import { RuntimeIdentitySchema } from '../../src/evaluation-core/contracts/index.js';
import {
  createBuiltinAnalysisNodes,
  createBuiltinAnalysisSchemaValidators,
  createBuiltinMissingPolicies,
} from '../../src/evaluation-core/analysis/index.js';
import type { EvaluationEvaluator } from '../../src/evaluation-core/evaluation/index.js';
import type { ExecutionExecutor } from '../../src/evaluation-core/execution/index.js';
import { bootstrapPairedDiffCI } from '../../src/eval-core/bootstrap.js';
import { computeVerdict } from '../../src/eval-core/verdict.js';
import { runAssertions, runAsyncAssertions } from '../../src/grading/assertions.js';
import { computeAgreementWithCI } from '../../src/grading/human-gold.js';
import { llmJudgeEnsemble } from '../../src/grading/judge.js';
import { computeLayeredScores } from '../../src/grading/layered-scores.js';
import {
  AGREEMENT_ANALYSIS_IMPLEMENTATION_ID,
  ASSERTION_LAYER_ANALYSIS_IMPLEMENTATION_ID,
  BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
  COMPOSITE_ANALYSIS_IMPLEMENTATION_ID,
  DIMENSION_ANALYSIS_IMPLEMENTATION_ID,
  EXECUTION_ASSERTION_BINDINGS,
  EXECUTION_ASSERTION_CONTEXT_SCHEMA_VERSION,
  EXECUTION_ASSERTION_EVALUATOR_IDENTITY,
  EXECUTION_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
  JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID,
  JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
  LLM_ASSERTION_BINDINGS,
  LLM_ASSERTION_CONTEXT_SCHEMA_VERSION,
  LLM_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
  OUTPUT_ASSERTION_BINDINGS,
  OUTPUT_ASSERTION_CONTEXT_SCHEMA_VERSION,
  OUTPUT_ASSERTION_EVALUATOR_IDENTITY,
  OUTPUT_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
  RELEASE_DECISION_POLICY_IMPLEMENTATION_ID,
  RUBRIC_JUDGE_BINDINGS,
  RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION,
  RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID,
  createAgreementAnalysisNodes,
  createAgreementParameterSchemaValidators,
  createAgreementTableSchemaValidators,
  createAssertionLayerAnalysisNodes,
  createAssertionLayerParameterSchemaValidators,
  createAssertionLayerTableSchemaValidators,
  createBootstrapFamilyAnalysisNodes,
  createBootstrapFamilyParameterSchemaValidators,
  createBootstrapFamilyTableSchemaValidators,
  createCompositeAnalysisNodes,
  createCompositeParameterSchemaValidators,
  createCompositeTableSchemaValidators,
  createDimensionAnalysisNodes,
  createDimensionParameterSchemaValidators,
  createDimensionTableSchemaValidators,
  createExecutionAssertionEvaluatorImplementation,
  createJudgeAggregationAnalysisNodes,
  createJudgeAggregationSchemaValidators,
  createLlmAssertionEvaluatorIdentity,
  createLlmAssertionEvaluatorImplementation,
  createReleaseDecisionParameterSchemaValidators,
  createReleaseDecisionPolicies,
  createRubricJudgeEvaluatorIdentity,
  createRubricJudgeEvaluatorImplementation,
  createSameProcessEvaluatorAdapter,
  createOutputAssertionEvaluatorImplementation,
  llmAssertionInstrument,
  rubricJudgeInstrument,
  rubricJudgeInstrumentId,
  type LlmAssertionType,
  type OmkLlmJudgeInvocationPort,
  type OmkLlmJudgeInvocationRequest,
} from '../../src/eval-workflows/runtime-adapter/index.js';
import type { Assertion, ExecutorFn, Report, Sample, VariantSummary } from '../../src/types/index.js';
import { testRuntime, validDefinition, validPolicy } from './compiler/fixtures.js';

interface Fixture {
  legacyBaseline: { bootstrapSeed: number; promptHashes: Record<string, string> };
  deterministicAssertions: { assertions: Assertion[] };
  fixedResponseAssertions: {
    sample: Sample;
    assertions: Assertion[];
    replayScores: number[];
  };
}

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../fixtures/evaluation-core/scoring-equivalence-v1.json',
  import.meta.url,
)), 'utf8')) as Fixture;

const SAMPLE_IDS = ['sample-1', 'sample-2', 'sample-3', 'sample-4'] as const;
const TARGET_IDS = ['control', 'treatment'] as const;
const ASSERTION_METRICS = [
  'contains-hello',
  'short-enough',
  'contains-missing',
  'fact-set',
] as const;
const EXECUTION_METRIC = 'cost-within-budget';
const EXECUTION_ASSERTION: Assertion = { type: 'cost_max', value: 0.01 };
const LLM_CASES = [
  ['semantic_similarity', 4, 4],
  ['faithfulness', 3, 2],
  ['answer_relevancy', 3, 5],
  ['context_recall', 4, 3],
] as const satisfies readonly [LlmAssertionType, number, number][];
const RUBRIC_SCORES: Readonly<Record<string, readonly number[]>> = {
  control: [2, 3, 4, 3],
  treatment: [3, 4, 5, 4],
};
const COMPLETE_USAGE: UsageRecord = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  providerCost: { amount: 0.001, currency: 'USD', reportedByProvider: true },
};
const PROVIDER_ID = 'test.differential-provider/v1';

type DifferentialExceptionId = 'issue-481' | 'issue-484' | 'issue-489' | 'issue-492';
type DifferentialExceptionStatus = 'accepted' | 'blocking';
interface DifferentialException {
  readonly exceptionId: DifferentialExceptionId;
  readonly status: DifferentialExceptionStatus;
  readonly owningIssue: `https://github.com/lizhiyao/oh-my-knowledge/issues/${number}`;
  readonly reason: string;
}

const DIFFERENTIAL_EXCEPTIONS = Object.freeze([
  {
    exceptionId: 'issue-481',
    status: 'accepted',
    owningIssue: 'https://github.com/lizhiyao/oh-my-knowledge/issues/481',
    reason: 'Provider and parse failures remain structured missing or invalid readings, not false.',
  },
  {
    exceptionId: 'issue-484',
    status: 'accepted',
    owningIssue: 'https://github.com/lizhiyao/oh-my-knowledge/issues/484',
    reason: 'json_schema validator state is isolated per evaluator session.',
  },
  {
    exceptionId: 'issue-489',
    status: 'blocking',
    owningIssue: 'https://github.com/lizhiyao/oh-my-knowledge/issues/489',
    reason: 'Legacy async assertion not semantics are not accepted as the Core cutover baseline.',
  },
  {
    exceptionId: 'issue-492',
    status: 'accepted',
    owningIssue: 'https://github.com/lizhiyao/oh-my-knowledge/issues/492',
    reason: 'Malformed, coerced, and zero-sentinel rubric responses are not valid readings.',
  },
] as const satisfies readonly DifferentialException[]);

class DeterministicClock implements EvaluationEngineClock {
  #now = 0;

  monotonicNow(): number {
    const current = this.#now;
    this.#now += 1;
    return current;
  }

  timestamp(): string {
    return new Date(Date.UTC(2026, 7, 31) + this.#now).toISOString();
  }

  async sleep(_delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
  }
}

function providerIdentity(): RuntimeIdentity {
  return RuntimeIdentitySchema.parse({
    implementationId: PROVIDER_ID,
    version: '1.0.0',
    fingerprint: digestCanonicalJson({ provider: PROVIDER_ID, fixture: 'scoring-equivalence-v1' }),
    fingerprintBasis: 'content-derived',
    assuranceLevel: 'verified',
    capabilities: { invocation: 'single-call', cancellation: 'cooperative' },
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  });
}

function coordinateFromPrompt(prompt: string): { targetId: string; sampleId: string } {
  const match = prompt.match(/\[(control|treatment):(sample-[1-4])\]/);
  if (match === null) throw new Error(`Missing differential coordinate in prompt: ${prompt}`);
  return { targetId: match[1], sampleId: match[2] };
}

function providerPort(failingPromptId?: string): OmkLlmJudgeInvocationPort {
  const llmScores = new Map(LLM_CASES.map(([type, _threshold, score]) => [
    llmAssertionInstrument(type).promptId,
    score,
  ]));
  return Object.freeze({
    identity: providerIdentity(),
    providerCost: { reporting: 'optional' as const },
    async invoke(request: Readonly<OmkLlmJudgeInvocationRequest>) {
      if (request.promptId === failingPromptId) {
        return {
          invocationStatus: 'failed' as const,
          reasonCode: 'fixture-provider-unavailable',
          usage: COMPLETE_USAGE,
        };
      }
      const llmScore = llmScores.get(request.promptId);
      if (llmScore !== undefined) {
        return {
          invocationStatus: 'completed' as const,
          output: JSON.stringify({ score: llmScore, reason: `score ${llmScore}` }),
          usage: COMPLETE_USAGE,
        };
      }
      const coordinate = coordinateFromPrompt(request.prompt);
      const sampleIndex = SAMPLE_IDS.indexOf(coordinate.sampleId as typeof SAMPLE_IDS[number]);
      const score = RUBRIC_SCORES[coordinate.targetId]?.[sampleIndex];
      if (score === undefined) throw new Error('Unknown rubric replay coordinate.');
      return {
        invocationStatus: 'completed' as const,
        output: JSON.stringify({ score, reason: `score ${score}`, reasoning: `reasoning ${score}` }),
        usage: COMPLETE_USAGE,
      };
    },
  });
}

function llmCriterion(type: LlmAssertionType, threshold: number): JsonValue {
  const source = type === 'faithfulness'
    ? { context: 'Hello world is grounded.' }
    : type === 'answer_relevancy'
      ? { question: 'Say hello.' }
      : { reference: 'Hello' };
  return {
    schemaVersion: LLM_ASSERTION_CONTEXT_SCHEMA_VERSION,
    criterionId: `${type.replaceAll('_', '-')}-criterion`,
    assertionType: type,
    threshold,
    weight: 1,
    ...source,
  } as unknown as JsonValue;
}

function outputFor(targetId: string, sampleId: string): string {
  return `Hello world [${targetId}:${sampleId}]`;
}

function assertionCriterionId(metricId: string): string {
  if ((ASSERTION_METRICS as readonly string[]).includes(metricId)) return metricId;
  if (metricId === EXECUTION_METRIC) return `${EXECUTION_METRIC}-criterion`;
  const llmCase = LLM_CASES.find(([type]) => (
    metricId === `llm-${type.replaceAll('_', '-')}-pass`
  ));
  if (llmCase !== undefined) return `${llmCase[0].replaceAll('_', '-')}-criterion`;
  throw new Error(`Unknown assertion-layer Metric ${metricId}.`);
}

function createDefinition(): EvaluationDefinition {
  const definition = validDefinition();
  definition.dataset = {
    datasetId: 'scoring-equivalence-v1',
    samples: SAMPLE_IDS.map((sampleId, index) => ({
      sampleId,
      input: { sampleId },
      executionContext: {},
      expected: { answer: 'Hello' },
      evaluationContext: {
        outputAssertions: {
          schemaVersion: OUTPUT_ASSERTION_CONTEXT_SCHEMA_VERSION,
          criteria: fixture.deterministicAssertions.assertions.slice(0, 4).map(
            (assertion, assertionIndex) => ({
              criterionId: ASSERTION_METRICS[assertionIndex],
              metricId: ASSERTION_METRICS[assertionIndex],
              assertion: assertion as unknown as JsonValue,
            }),
          ),
        },
        ...Object.fromEntries(LLM_CASES.map(([type, threshold]) => [
          `${type}Criterion`,
          llmCriterion(type, threshold),
        ])),
        rubricJudge: {
          schemaVersion: RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION,
          criterionId: 'correctness',
          prompt: 'Say hello.',
          rubric: 'The answer must be correct and concise.',
        },
        executionAssertions: {
          schemaVersion: EXECUTION_ASSERTION_CONTEXT_SCHEMA_VERSION,
          sourceKinds: ['execution-facts'],
          criteria: [{
            criterionId: `${EXECUTION_METRIC}-criterion`,
            metricId: EXECUTION_METRIC,
            assertion: EXECUTION_ASSERTION as unknown as JsonValue,
          }],
        },
      },
      annotations: {},
      analysis: {
        memberships: [],
        context: { value: { goldScore: index + 2 }, classification: 'gold' },
      },
    })),
    annotations: { fixture: 'scoring-equivalence-v1' },
  };

  const rubricInstrument = rubricJudgeInstrument({ lengthDebias: true, tracePolicy: 'none' });
  definition.evaluators = [{
    evaluatorId: 'output-assertions',
    evaluatorKind: 'assertion',
    implementationId: OUTPUT_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
    measurement: {
      instrumentId: 'omk-output-assertions',
      ensembleMemberId: 'deterministic-local',
      replicateGroupId: 'deterministic-primary',
      replicateIndex: 0,
    },
    metricIds: [...ASSERTION_METRICS],
    inputs: [
      { bindingId: OUTPUT_ASSERTION_BINDINGS.actual, sourceKind: 'output', pointer: '/answer' },
      {
        bindingId: OUTPUT_ASSERTION_BINDINGS.criteria,
        sourceKind: 'evaluation-context',
        pointer: '/outputAssertions',
      },
    ],
  }, {
    evaluatorId: 'execution-assertions',
    evaluatorKind: 'assertion',
    implementationId: EXECUTION_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
    measurement: {
      instrumentId: 'omk-execution-assertions',
      ensembleMemberId: 'deterministic-local',
      replicateGroupId: 'deterministic-primary',
      replicateIndex: 0,
    },
    metricIds: [EXECUTION_METRIC],
    inputs: [{
      bindingId: EXECUTION_ASSERTION_BINDINGS.facts,
      sourceKind: 'execution-facts',
      pointer: '',
    }, {
      bindingId: EXECUTION_ASSERTION_BINDINGS.criteria,
      sourceKind: 'evaluation-context',
      pointer: '/executionAssertions',
    }],
  }, ...LLM_CASES.map(([type]) => {
    const instrument = llmAssertionInstrument(type);
    return {
      evaluatorId: `llm-${type.replaceAll('_', '-')}`,
      evaluatorKind: 'llm-rubric' as const,
      implementationId: LLM_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
      measurement: {
        instrumentId: instrument.promptId,
        ensembleMemberId: 'fixed-provider',
        replicateGroupId: 'assertion-primary',
        replicateIndex: 0,
      },
      metricIds: [`llm-${type.replaceAll('_', '-')}-pass`],
      inputs: [
        { bindingId: LLM_ASSERTION_BINDINGS.actual, sourceKind: 'output' as const, pointer: '/answer' },
        {
          bindingId: LLM_ASSERTION_BINDINGS.criterion,
          sourceKind: 'evaluation-context' as const,
          pointer: `/${type}Criterion`,
        },
      ],
      config: {
        evaluator: { classification: 'public' as const, value: instrument as unknown as JsonValue },
        runtime: {
          executorId: PROVIDER_ID,
          model: 'fixture-judge',
          effort: 'low',
          promptVariant: instrument.promptId,
        },
      },
    };
  }), ...(['alpha', 'beta'] as const).flatMap((member) => [0, 1].map((replicateIndex) => ({
    evaluatorId: `rubric-${member}-${replicateIndex}`,
    evaluatorKind: 'llm-rubric' as const,
    implementationId: RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID,
    measurement: {
      instrumentId: rubricJudgeInstrumentId(rubricInstrument),
      ensembleMemberId: member,
      replicateGroupId: 'rubric-primary',
      replicateIndex,
    },
    metricIds: ['rubric-score'],
    inputs: [
      { bindingId: RUBRIC_JUDGE_BINDINGS.actual, sourceKind: 'output' as const, pointer: '/answer' },
      {
        bindingId: RUBRIC_JUDGE_BINDINGS.criterion,
        sourceKind: 'evaluation-context' as const,
        pointer: '/rubricJudge',
      },
    ],
    config: {
      evaluator: { classification: 'public' as const, value: rubricInstrument as unknown as JsonValue },
      runtime: {
        executorId: PROVIDER_ID,
        model: `${member}-model`,
        effort: 'low',
        promptVariant: rubricInstrument.promptId,
      },
    },
  })))];

  definition.metrics = [
    ...ASSERTION_METRICS,
    EXECUTION_METRIC,
    ...LLM_CASES.map(([type]) => `llm-${type.replaceAll('_', '-')}-pass`),
  ].map((metricId) => ({
    metricId,
    valueType: 'boolean' as const,
    scope: 'sample' as const,
    direction: 'higher-is-better' as const,
    missingPolicyId: 'exclude/v1',
  }));
  definition.metrics.push({
    metricId: 'rubric-score',
    valueType: 'numeric',
    scope: 'sample',
    scale: { min: 1, max: 5 },
    direction: 'higher-is-better',
    missingPolicyId: 'exclude/v1',
  });
  definition.experiment = {
    trials: 1,
    seed: 'scoring-equivalence-v1',
    randomizationSlots: [
      { targetId: 'control', randomizationSlotId: 'slot-control' },
      { targetId: 'treatment', randomizationSlotId: 'slot-treatment' },
    ],
    sampling: {
      experimentalUnit: 'sample',
      pairingKey: '/sampleId',
      repeatedMeasures: true,
      resamplingUnit: 'paired-block',
      estimatorId: 'bootstrap.paired-difference-percentile/v1',
      seedCoupling: 'shared-within-block',
    },
    scheduling: { schedulingKind: 'randomized-block', blockSize: 2 },
  };
  const booleanMetrics = definition.metrics.filter((metric) => metric.valueType === 'boolean');
  definition.analysisGraph.nodes = [{
    analysisNodeKind: 'reducer',
    nodeId: 'assertion-layer',
    implementationId: ASSERTION_LAYER_ANALYSIS_IMPLEMENTATION_ID,
    inputs: booleanMetrics.map((metric) => ({
      inputKind: 'metric-observations' as const,
      referenceId: metric.metricId,
    })),
    outputResultId: 'assertion-layer',
    parameters: {
      criteria: booleanMetrics.map((metric) => ({
        criterionId: assertionCriterionId(metric.metricId),
        metricId: metric.metricId,
        layerDisposition: metric.metricId === 'short-enough' || metric.metricId === EXECUTION_METRIC
          ? 'behavior'
          : 'fact',
        weight: metric.metricId === 'contains-hello' ? 2
          : metric.metricId === 'contains-missing' ? 3
            : metric.metricId === 'fact-set' ? 2 : 1,
      })),
    },
  }, {
    analysisNodeKind: 'reducer',
    nodeId: 'judge-replicate',
    implementationId: JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
    inputs: [{ inputKind: 'metric-observations', referenceId: 'rubric-score' }],
    outputResultId: 'judge-replicate',
  }, {
    analysisNodeKind: 'reducer',
    nodeId: 'judge-ensemble',
    implementationId: JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID,
    inputs: [{ inputKind: 'analysis-result', referenceId: 'judge-replicate' }],
    outputResultId: 'judge-ensemble',
  }, {
    analysisNodeKind: 'reducer',
    nodeId: 'dimension-table',
    implementationId: DIMENSION_ANALYSIS_IMPLEMENTATION_ID,
    inputs: [{ inputKind: 'analysis-result', referenceId: 'judge-ensemble' }],
    outputResultId: 'dimension-table',
    parameters: {
      dimensions: [{
        dimensionId: 'correctness',
        metricId: 'rubric-score',
        analysisResultId: 'judge-ensemble',
      }],
    },
  }, {
    analysisNodeKind: 'reducer',
    nodeId: 'composite-table',
    implementationId: COMPOSITE_ANALYSIS_IMPLEMENTATION_ID,
    inputs: [
      { inputKind: 'analysis-result', referenceId: 'assertion-layer' },
      { inputKind: 'analysis-result', referenceId: 'dimension-table' },
    ],
    outputResultId: 'composite-table',
    parameters: {
      layers: [
        { layerId: 'fact', analysisResultId: 'assertion-layer', sourceKind: 'assertion-layer', selector: 'fact' },
        { layerId: 'behavior', analysisResultId: 'assertion-layer', sourceKind: 'assertion-layer', selector: 'behavior' },
        { layerId: 'judge', analysisResultId: 'dimension-table', sourceKind: 'dimension', selector: 'aggregate' },
      ],
    },
  }, {
    analysisNodeKind: 'estimator',
    nodeId: 'agreement-table',
    implementationId: AGREEMENT_ANALYSIS_IMPLEMENTATION_ID,
    inputs: [{ inputKind: 'analysis-result', referenceId: 'dimension-table' }],
    outputResultId: 'agreement-table',
    parameters: {
      source: {
        analysisResultId: 'dimension-table',
        sourceKind: 'dimension',
        selector: 'aggregate',
        targetId: 'treatment',
      },
      gold: {
        contextPointer: '/goldScore',
        annotatorId: 'human-a',
        annotationVersion: 'v1',
        scale: { min: 1, max: 5 },
      },
      sampleIds: [...SAMPLE_IDS],
      resamples: 500,
      alpha: 0.05,
      seed: fixture.legacyBaseline.bootstrapSeed,
    },
  }, {
    analysisNodeKind: 'estimator',
    nodeId: 'bootstrap-family',
    implementationId: BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
    inputs: [{ inputKind: 'analysis-result', referenceId: 'composite-table' }],
    outputResultId: 'bootstrap-family',
    parameters: {
      source: {
        analysisResultId: 'composite-table',
        sourceKind: 'composite',
        selector: 'aggregate',
      },
      targetIds: [...TARGET_IDS],
      sampleIds: [...SAMPLE_IDS],
      comparisons: [{
        comparisonId: 'control-vs-treatment',
        controlTargetId: 'control',
        treatmentTargetId: 'treatment',
        comparisonDesign: 'paired',
      }],
      resamples: 500,
      alpha: 0.05,
      seed: fixture.legacyBaseline.bootstrapSeed,
    },
  }];
  definition.comparisons = [{
    comparisonId: 'control-vs-treatment',
    controlTargetId: 'control',
    treatmentTargetIds: ['treatment'],
    metricIds: ['rubric-score'],
  }];
  definition.decisionPolicy = {
    decisionPolicyId: 'release-decision',
    implementationId: RELEASE_DECISION_POLICY_IMPLEMENTATION_ID,
    analysisResultIds: ['judge-ensemble', 'composite-table', 'bootstrap-family'],
    comparisonFamily: [{
      comparisonId: 'control-vs-treatment',
      treatmentTargetId: 'treatment',
      metricId: 'rubric-score',
      analysisResultId: 'bootstrap-family',
    }],
    comparisonFamilyResultId: 'bootstrap-family',
    minimumEvidenceStatus: 'complete',
    parameters: {
      sources: {
        compositeResultId: 'composite-table',
        bootstrapFamilyResultId: 'bootstrap-family',
        judgeEnsemble: {
          analysisResultId: 'judge-ensemble',
          metricId: 'rubric-score',
          instrumentId: rubricJudgeInstrumentId(rubricInstrument),
          replicateGroupId: 'rubric-primary',
        },
      },
      targetIds: [...TARGET_IDS],
      sampleIds: [...SAMPLE_IDS],
      thresholds: {
        layerScore: 3,
        triviallySmallDifference: 0.1,
        minimumSampleCount: 20,
        judgeDissentPearson: 0.4,
        holdoutGap: 0.5,
      },
    },
  };
  return definition;
}

function createPolicy(): MeasurementPolicy {
  const policy = validPolicy();
  delete policy.execution.timeoutMs;
  delete policy.evaluation.timeoutMs;
  policy.retry.maxAttempts = 1;
  policy.evaluation.retry.maxAttempts = 1;
  policy.evidence.trace = 'none';
  policy.evidence.evidence = 'full';
  policy.evidence.maximumClassification = 'gold';
  return policy;
}

function evaluatorConfig(evaluatorId: string): {
  instrument: ReturnType<typeof llmAssertionInstrument> | ReturnType<typeof rubricJudgeInstrument>;
  runtime: { executorId: string; model: string; effort: 'low'; promptVariant: string };
} {
  if (evaluatorId.startsWith('llm-')) {
    const type = LLM_CASES.find(([candidate]) => (
      evaluatorId === `llm-${candidate.replaceAll('_', '-')}`
    ))?.[0];
    if (type === undefined) throw new Error(`Unknown LLM assertion ${evaluatorId}`);
    const instrument = llmAssertionInstrument(type);
    return {
      instrument,
      runtime: {
        executorId: PROVIDER_ID,
        model: 'fixture-judge',
        effort: 'low',
        promptVariant: instrument.promptId,
      },
    };
  }
  const member = evaluatorId.split('-')[1];
  const instrument = rubricJudgeInstrument({ lengthDebias: true, tracePolicy: 'none' });
  return {
    instrument,
    runtime: {
      executorId: PROVIDER_ID,
      model: `${member}-model`,
      effort: 'low',
      promptVariant: instrument.promptId,
    },
  };
}

function evaluatorPort(evaluatorId: string, provider: OmkLlmJudgeInvocationPort): EvaluationEvaluator {
  if (evaluatorId === 'output-assertions') {
    return createSameProcessEvaluatorAdapter({
      identity: OUTPUT_ASSERTION_EVALUATOR_IDENTITY,
      sessionIsolationKey: evaluatorId,
      resourceLeases: {
        forRun: () => ({
          bindingId: evaluatorId,
          consumerKind: 'evaluator',
          resourcesByResourceId: new Map(),
        }),
      },
      implementation: createOutputAssertionEvaluatorImplementation(),
    });
  }
  if (evaluatorId === 'execution-assertions') {
    return createSameProcessEvaluatorAdapter({
      identity: EXECUTION_ASSERTION_EVALUATOR_IDENTITY,
      sessionIsolationKey: evaluatorId,
      resourceLeases: {
        forRun: () => ({
          bindingId: evaluatorId,
          consumerKind: 'evaluator',
          resourcesByResourceId: new Map(),
        }),
      },
      implementation: createExecutionAssertionEvaluatorImplementation(),
    });
  }
  const config = evaluatorConfig(evaluatorId);
  if (evaluatorId.startsWith('llm-')) {
    const identity = createLlmAssertionEvaluatorIdentity({
        instrument: config.instrument as ReturnType<typeof llmAssertionInstrument>,
        runtime: config.runtime,
        invocation: provider,
      });
    return createSameProcessEvaluatorAdapter({
      identity,
      sessionIsolationKey: evaluatorId,
      resourceLeases: {
        forRun: () => ({
          bindingId: evaluatorId,
          consumerKind: 'evaluator',
          resourcesByResourceId: new Map(),
        }),
      },
      implementation: createLlmAssertionEvaluatorImplementation(provider),
    });
  }
  const identity = createRubricJudgeEvaluatorIdentity({
    instrument: config.instrument as ReturnType<typeof rubricJudgeInstrument>,
    runtime: config.runtime,
    invocation: provider,
  });
  return createSameProcessEvaluatorAdapter({
    identity,
    sessionIsolationKey: evaluatorId,
    resourceLeases: {
      forRun: () => ({
        bindingId: evaluatorId,
        consumerKind: 'evaluator',
        resourcesByResourceId: new Map(),
      }),
    },
    implementation: createRubricJudgeEvaluatorImplementation(provider),
  });
}

function createRuntime(
  definition: EvaluationDefinition,
  failingPromptId?: string,
): EvaluationEngineRuntime {
  const base = testRuntime({
    executorProviderCost: { reporting: 'optional' },
    evaluatorValueTypes: ['boolean', 'numeric'],
    evaluatorInputSourceKinds: ['output', 'evaluation-context'],
    analysisValueTypes: ['boolean', 'numeric'],
    samplingResamplingUnits: ['paired-block'],
  });
  const executorResolution = base.resolveExecutor(Object.freeze({
    requirementKind: 'executor',
    referenceId: 'control',
    targetKind: 'function',
    protocolId: 'omk.invoke/v1',
    executorId: 'executor-alias',
    versionConstraint: '^1.0.0',
    executionRequirements: definition.targets[0].executionRequirements,
  }));
  if (executorResolution instanceof Promise) throw new Error('Unexpected async test Runtime.');
  const executorIdentity = RuntimeIdentitySchema.parse(
    (executorResolution as { identity: unknown }).identity,
  );
  const executor: ExecutionExecutor = {
    identity: executorIdentity,
    async openRun() {
      return {
        async openTrial(context) {
          const sampleId = (context.input as { sampleId: string }).sampleId;
          return {
            async execute() {
              return {
                output: {
                  value: { answer: outputFor(context.targetId, sampleId) },
                  classification: 'public' as const,
                },
                usage: {
                  inputTokens: 5,
                  outputTokens: 5,
                  totalTokens: 10,
                  providerCost: {
                    amount: 0.005,
                    currency: 'USD',
                    reportedByProvider: true,
                  },
                },
              };
            },
            dispose() {},
          };
        },
        dispose() {},
      };
    },
  };
  const provider = providerPort(failingPromptId);
  const evaluators = new Map(definition.evaluators.map((evaluator) => [
    evaluator.evaluatorId,
    evaluatorPort(evaluator.evaluatorId, provider),
  ]));
  const analysisNodes = new Map([
    ...createBuiltinAnalysisNodes(),
    ...createAssertionLayerAnalysisNodes(),
    ...createJudgeAggregationAnalysisNodes(),
    ...createDimensionAnalysisNodes(),
    ...createCompositeAnalysisNodes(),
    ...createAgreementAnalysisNodes(),
    ...createBootstrapFamilyAnalysisNodes(),
  ]);
  const missingPolicies = createBuiltinMissingPolicies();
  const decisionPolicies = createReleaseDecisionPolicies();
  return {
    bindings: {
      resolveExecutor() {
        return {
          runtimeKind: 'executor',
          resolution: { identity: executor.identity, satisfiesVersionConstraint: true },
          port: executor,
        };
      },
      resolveEvaluator(requirement) {
        const port = evaluators.get(requirement.referenceId);
        if (port === undefined) throw new Error(`Missing evaluator ${requirement.referenceId}`);
        return {
          runtimeKind: 'evaluator',
          resolution: { identity: port.identity, satisfiesVersionConstraint: true },
          port,
        };
      },
      resolveAnalysis(requirement) {
        if (requirement.requirementKind === 'missing-policy') {
          const port = missingPolicies.get(requirement.implementationId);
          if (port === undefined) throw new Error(`Missing policy ${requirement.implementationId}`);
          return {
            runtimeKind: 'missing-policy',
            resolution: { identity: port.identity, satisfiesVersionConstraint: true },
            port,
          };
        }
        if (requirement.requirementKind === 'decision-policy') {
          const port = decisionPolicies.get(requirement.implementationId);
          if (port === undefined) throw new Error(`Missing decision ${requirement.implementationId}`);
          return {
            runtimeKind: 'decision-policy',
            resolution: { identity: port.identity, satisfiesVersionConstraint: true },
            port,
          };
        }
        const port = analysisNodes.get(requirement.implementationId);
        if (port === undefined) throw new Error(`Missing analysis ${requirement.implementationId}`);
        return {
          runtimeKind: 'analysis-node',
          resolution: { identity: port.identity, satisfiesVersionConstraint: true },
          port,
        };
      },
    },
    clock: new DeterministicClock(),
    schemaValidators: new Map([
      ...base.schemaValidators,
      ...createBuiltinAnalysisSchemaValidators(),
      ...createAssertionLayerParameterSchemaValidators(),
      ...createAssertionLayerTableSchemaValidators(),
      ...createJudgeAggregationSchemaValidators(),
      ...createDimensionParameterSchemaValidators(),
      ...createDimensionTableSchemaValidators(),
      ...createCompositeParameterSchemaValidators(),
      ...createCompositeTableSchemaValidators(),
      ...createAgreementParameterSchemaValidators(),
      ...createAgreementTableSchemaValidators(),
      ...createBootstrapFamilyParameterSchemaValidators(),
      ...createBootstrapFamilyTableSchemaValidators(),
      ...createReleaseDecisionParameterSchemaValidators(),
    ]),
  };
}

function replayExecutor(scores: readonly number[]): ExecutorFn {
  let cursor = 0;
  return async () => {
    const score = scores[cursor++];
    if (score === undefined) throw new Error('Legacy fixed-response replay exhausted.');
    return {
      ok: true,
      output: JSON.stringify({ score, reason: `score ${score}`, reasoning: `reasoning ${score}` }),
      durationMs: 1,
      durationApiMs: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUSD: 0.001,
      stopReason: 'end_turn',
      numTurns: 1,
    };
  };
}

const failedLegacyExecutor: ExecutorFn = async () => ({
  ok: false,
  output: null,
  durationMs: 1,
  durationApiMs: 1,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUSD: 0.001,
  stopReason: 'provider_error',
  numTurns: 1,
  error: 'fixture provider unavailable',
});

async function legacyProjection() {
  const coordinates = await Promise.all(TARGET_IDS.flatMap((targetId) => SAMPLE_IDS.map(
    async (sampleId, sampleIndex) => {
      const output = outputFor(targetId, sampleId);
      const deterministic = runAssertions(
        output,
        fixture.deterministicAssertions.assertions.slice(0, 4),
        {},
      );
      const asyncAssertions = await runAsyncAssertions(
        output,
        fixture.fixedResponseAssertions.assertions,
        {
          executor: replayExecutor(fixture.fixedResponseAssertions.replayScores),
          judgeModel: 'fixture:judge',
          sample: { ...fixture.fixedResponseAssertions.sample, sample_id: sampleId },
          samplesDir: '.',
        },
      );
      const executionAssertions = runAssertions(
        output,
        [EXECUTION_ASSERTION],
        { costUSD: 0.005 },
      );
      const desiredJudgeScore = RUBRIC_SCORES[targetId][sampleIndex];
      const judgeExecutors = {
        alpha: replayExecutor([desiredJudgeScore, desiredJudgeScore]),
        beta: replayExecutor([desiredJudgeScore, desiredJudgeScore]),
      };
      const judges = [
        { executor: 'alpha', model: 'alpha-model' },
        { executor: 'beta', model: 'beta-model' },
      ];
      const judgeEnsemble = await llmJudgeEnsemble({
        output,
        rubric: 'The answer must be correct and concise.',
        prompt: 'Say hello.',
        executor: judgeExecutors.alpha,
        model: 'alpha-model',
      }, judges, (executor) => judgeExecutors[executor as keyof typeof judgeExecutors], 2);
      const judgeScore = judgeEnsemble.score;
      const layered = computeLayeredScores({
        assertions: {
          details: [
            ...deterministic.details,
            ...executionAssertions.details,
            ...asyncAssertions.details,
          ],
        },
        llmScore: judgeScore,
      });
      return {
        targetId,
        sampleId,
        deterministic,
        executionAssertions,
        asyncAssertions,
        judgeEnsemble,
        judgeScore,
        ...layered,
      };
    },
  )));
  const scores = Object.fromEntries(TARGET_IDS.map((targetId) => [
    targetId,
    coordinates.filter((entry) => entry.targetId === targetId).map((entry) => entry.compositeScore),
  ])) as Record<typeof TARGET_IDS[number], number[]>;
  const comparison = bootstrapPairedDiffCI(
    scores.control.map((control, index) => ({ a: control, b: scores.treatment[index] })),
    0.05,
    500,
    fixture.legacyBaseline.bootstrapSeed,
  );
  const agreement = computeAgreementWithCI(SAMPLE_IDS.map((sampleId, index) => ({
    unitId: sampleId,
    coderA: index + 2,
    coderB: RUBRIC_SCORES.treatment[index],
  })), { samples: 500, alpha: 0.05, seed: fixture.legacyBaseline.bootstrapSeed });
  const average = (values: readonly number[]) => (
    values.reduce((sum, value) => sum + value, 0) / values.length
  );
  const summary = (targetId: typeof TARGET_IDS[number]): VariantSummary => {
    const target = coordinates.filter((entry) => entry.targetId === targetId);
    return {
      totalSamples: target.length,
      successCount: target.length,
      errorCount: 0,
      errorRate: 0,
      avgDurationMs: 0,
      avgInputTokens: 0,
      avgOutputTokens: 0,
      avgTotalTokens: 0,
      totalCostUSD: 0,
      totalExecCostUSD: 0,
      totalJudgeCostUSD: 0,
      avgCostPerSample: 0,
      avgNumTurns: 1,
      avgFactScore: average(target.map((entry) => entry.layeredScores.factScore ?? 0)),
      avgBehaviorScore: average(target.map((entry) => entry.layeredScores.behaviorScore ?? 0)),
      avgJudgeScore: average(target.map((entry) => entry.layeredScores.judgeScore ?? 0)),
      avgCompositeScore: average(target.map((entry) => entry.compositeScore)),
    };
  };
  const report: Report = {
    kind: 'evaluation',
    id: 'differential-legacy',
    meta: {
      variants: [...TARGET_IDS],
      model: 'fixture',
      judgeModels: [{ executor: 'fixture', model: 'judge' }],
      executor: 'fixture',
      sampleCount: SAMPLE_IDS.length,
      taskCount: coordinates.length,
      totalCostUSD: 0,
      timestamp: '2026-08-31T00:00:00.000Z',
      cliVersion: 'fixture',
      nodeVersion: 'fixture',
      artifactHashes: { control: 'fixture', treatment: 'fixture' },
      pairComparisons: [{
        control: 'control',
        treatment: 'treatment',
        diffBootstrapCI: comparison,
      }],
    },
    summary: { control: summary('control'), treatment: summary('treatment') },
    results: [],
  };
  return { coordinates, scores, comparison, agreement, verdict: computeVerdict(report, {
    gateThreshold: 3,
    triviallySmallDiff: 0.1,
  }) };
}

function completedAnalysisValue(result: Awaited<ReturnType<typeof runCore>>, resultId: string) {
  const record = result.artifacts.analysis.records.find((entry) => entry.resultId === resultId);
  if (record?.analysisStatus !== 'completed') throw new Error(`Missing completed ${resultId}.`);
  return record.value as Record<string, unknown>;
}

async function runCore(failingPromptId?: string) {
  const definition = createDefinition();
  const prepared = await createEvaluationEngine(createRuntime(definition, failingPromptId)).prepare(
    definition,
    createPolicy(),
  );
  const result = await prepared.start({ runId: 'scoring-equivalence-differential' }).result;
  if (result.status !== 'completed') throw new Error(`Core run did not complete: ${result.status}`);
  return result;
}

describe('Evaluation Core complete legacy differential conformance', () => {
  it('keeps every intentional difference typed, owned, and the unresolved not semantics blocking', () => {
    expect(DIFFERENTIAL_EXCEPTIONS.map((entry) => entry.exceptionId)).toEqual([
      'issue-481', 'issue-484', 'issue-489', 'issue-492',
    ]);
    expect(DIFFERENTIAL_EXCEPTIONS.filter((entry) => entry.status === 'blocking')).toEqual([
      expect.objectContaining({ exceptionId: 'issue-489' }),
    ]);
    expect(DIFFERENTIAL_EXCEPTIONS.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it('confines the approved provider-failure difference to issue #481', async () => {
    const faithfulness = llmAssertionInstrument('faithfulness');
    const core = await runCore(faithfulness.promptId);
    const failedRecords = core.artifacts.evaluation.records.filter((record) => (
      record.evaluatorId === 'llm-faithfulness'
    ));
    expect(failedRecords).toHaveLength(8);
    expect(failedRecords.every((record) => (
      record.evaluationStatus === 'failed'
      && record.error.code === 'judge-provider-failure'
      && record.usage?.totalTokens === COMPLETE_USAGE.totalTokens
      && record.usage?.providerCost?.amount === COMPLETE_USAGE.providerCost?.amount
    ))).toBe(true);
    expect(JSON.stringify(failedRecords)).not.toContain('fixture-provider-unavailable');

    const assertion = completedAnalysisValue(core, 'assertion-layer') as {
      groups: Array<{
        entries: Array<{
          metricId: string;
          rowStatus: string;
          reasonCode?: string;
          censored: boolean;
        }>;
        layers: {
          fact: {
            score: number;
            coverage: { evaluationFailedCriteria: number; evaluationFailedWeight: number };
          };
        };
      }>;
    };
    expect(assertion.groups.every((group) => {
      const entry = group.entries.find((candidate) => (
        candidate.metricId === 'llm-faithfulness-pass'
      ));
      return entry?.rowStatus === 'evaluation-failed'
        && entry.reasonCode === 'judge-provider-failure'
        && entry.censored === false
        && group.layers.fact.score === 3.4
        && group.layers.fact.coverage.evaluationFailedCriteria === 1
        && group.layers.fact.coverage.evaluationFailedWeight === 1;
    })).toBe(true);

    const legacy = await runAsyncAssertions(
      outputFor('control', 'sample-1'),
      [fixture.fixedResponseAssertions.assertions[1]],
      {
        executor: failedLegacyExecutor,
        judgeModel: 'fixture:judge',
        sample: fixture.fixedResponseAssertions.sample,
        samplesDir: '.',
      },
    );
    expect(legacy.details).toEqual([{
      type: 'faithfulness',
      value: '',
      weight: 1,
      passed: false,
      message: 'faithfulness judge error: fixture provider unavailable',
    }]);
    expect(DIFFERENTIAL_EXCEPTIONS.find((entry) => entry.exceptionId === 'issue-481'))
      .toMatchObject({ status: 'accepted' });
  });

  it('runs one sealed Execution → Evaluation → Analysis → Decision plan and matches legacy facts', async () => {
    const [core, legacy] = await Promise.all([runCore(), legacyProjection()]);
    expect(core.artifacts.execution.coverage).toMatchObject({ planned: 8, succeeded: 8 });
    expect(core.artifacts.evaluation.records.filter((record) => (
      record.evaluationStatus !== 'completed'
    )).map((record) => ({
      evaluatorId: record.evaluatorId,
      status: record.evaluationStatus,
      error: record.evaluationStatus === 'failed' ? record.error : undefined,
    }))).toEqual([]);
    expect(core.artifacts.evaluation.coverage).toMatchObject({ planned: 80, completed: 80 });
    expect(core.artifacts.analysis.coverage).toEqual({
      planned: 7,
      started: 7,
      completed: 7,
      inconclusive: 0,
      failed: 0,
      notStarted: 0,
    });
    expect(JSON.stringify(core.artifacts.execution)).not.toContain('goldScore');
    expect(JSON.stringify(core.artifacts.evaluation)).not.toContain('goldScore');
    expect(JSON.stringify(core.artifacts.analysis)).toContain('goldScore');

    const evaluationRows = core.artifacts.evaluation.records.flatMap((record) => (
      record.evaluationStatus === 'completed'
        ? record.observations.map((observation) => ({ record, observation }))
        : []
    ));
    expect(evaluationRows).toHaveLength(104);
    expect(evaluationRows.every(({ observation }) => observation.observationStatus === 'observed'))
      .toBe(true);
    expect(core.artifacts.evaluation.records.filter((record) => (
      record.evaluatorId.startsWith('llm-') || record.evaluatorId.startsWith('rubric-')
    )).every((record) => (
      record.evaluationStatus === 'completed' && record.usage?.totalTokens === 15
    ))).toBe(true);
    expect(core.artifacts.evaluation.records.filter((record) => (
      record.evaluatorId.startsWith('llm-') || record.evaluatorId.startsWith('rubric-')
    )).every((record) => (
      record.evaluationStatus === 'completed' && record.usage?.providerCost?.amount === 0.001
    ))).toBe(true);
    const promptEvidence = evaluationRows.flatMap(({ observation }) => {
      if (observation.evidence?.contentKind !== 'inline'
          || typeof observation.evidence.value !== 'object'
          || observation.evidence.value === null
          || Array.isArray(observation.evidence.value)) return [];
      const value = observation.evidence.value as Record<string, JsonValue>;
      return typeof value.promptId === 'string' && typeof value.promptHash === 'string'
        ? [[value.promptId, value.promptHash] as const]
        : [];
    });
    expect(Object.fromEntries(promptEvidence)).toEqual({
      'rag-answer-relevancy': fixture.legacyBaseline.promptHashes['rag-answer-relevancy'],
      'rag-context-recall': fixture.legacyBaseline.promptHashes['rag-context-recall'],
      'rag-faithfulness': fixture.legacyBaseline.promptHashes['rag-faithfulness'],
      'rubric-judge-debias-on': fixture.legacyBaseline.promptHashes['rubric-judge-debias-on'],
      'semantic-similarity': fixture.legacyBaseline.promptHashes['semantic-similarity'],
    });
    const rubricCoordinates = core.artifacts.evaluation.records.filter((record) => (
      record.evaluatorId.startsWith('rubric-')
    )).map((record) => [
      record.targetId,
      record.sampleId,
      record.trialIndex,
      record.measurement.ensembleMemberId,
      record.measurement.replicateIndex,
    ]);
    expect(new Set(rubricCoordinates.map((coordinate) => JSON.stringify(coordinate))).size)
      .toBe(32);
    for (const sampleId of SAMPLE_IDS) {
      const pairingBlocks = new Set(core.artifacts.execution.records.filter((record) => (
        record.sampleId === sampleId
      )).map((record) => record.samplingUnitIds.pairingBlockId));
      expect(pairingBlocks.size).toBe(1);
      expect([...pairingBlocks][0]).toMatch(/^sha256:[a-f0-9]{64}$/);
    }

    const assertion = completedAnalysisValue(core, 'assertion-layer') as {
      groups: Array<{
        targetId: string;
        sampleId: string;
        entries: Array<{
          criterionId: string;
          metricId: string;
          rowStatus: string;
          value?: boolean;
        }>;
        layers: { fact: { score: number }; behavior: { score: number } };
      }>;
    };
    const composite = completedAnalysisValue(core, 'composite-table') as {
      groups: Array<{
        targetId: string;
        sampleId: string;
        aggregate: { score: number };
        layers: Array<{
          binding: { layerId: string };
          layerStatus: string;
          score?: number;
        }>;
      }>;
    };
    for (const expected of legacy.coordinates) {
      const records = core.artifacts.evaluation.records.filter((record) => (
        record.targetId === expected.targetId
        && record.sampleId === expected.sampleId
        && record.evaluationStatus === 'completed'
      ));
      const evidenceValues = (evaluatorId: string) => {
        const record = records.find((candidate) => candidate.evaluatorId === evaluatorId);
        if (record?.evaluationStatus !== 'completed') throw new Error(`Missing ${evaluatorId}.`);
        return record.observations.map((observation) => {
          if (observation.evidence?.contentKind !== 'inline') {
            throw new Error(`Missing inline evidence for ${evaluatorId}.`);
          }
          return observation.evidence.value as Record<string, JsonValue>;
        });
      };
      expect(evidenceValues('output-assertions').map((value) => value.detail))
        .toEqual(expected.deterministic.details);
      expect(evidenceValues('execution-assertions').map((value) => value.detail))
        .toEqual(expected.executionAssertions.details);
      LLM_CASES.forEach(([type, threshold, score], index) => {
        expect(evidenceValues(`llm-${type.replaceAll('_', '-')}`)).toEqual([{
          schemaVersion: 'omk.llm-assertion-evidence/v1',
          criterionId: `${type.replaceAll('_', '-')}-criterion`,
          assertionType: type,
          threshold,
          weight: 1,
          layer: 'fact',
          promptId: llmAssertionInstrument(type).promptId,
          promptHash: llmAssertionInstrument(type).promptHash,
          score,
          reason: expected.asyncAssertions.details[index].message,
        }]);
      });
      for (const member of ['alpha', 'beta']) {
        for (const replicateIndex of [0, 1]) {
          expect(evidenceValues(`rubric-${member}-${replicateIndex}`)).toEqual([{
            schemaVersion: 'omk.rubric-judge-evidence/v1',
            criterionId: 'correctness',
            promptId: 'rubric-judge-debias-on',
            promptHash: fixture.legacyBaseline.promptHashes['rubric-judge-debias-on'],
            lengthDebias: true,
            tracePolicy: 'none',
            score: expected.judgeScore,
            reason: `score ${expected.judgeScore}`,
            reasoning: `reasoning ${expected.judgeScore}`,
          }]);
        }
      }
      const assertionGroup = assertion.groups.find((group) => (
        group.targetId === expected.targetId && group.sampleId === expected.sampleId
      ));
      const compositeGroup = composite.groups.find((group) => (
        group.targetId === expected.targetId && group.sampleId === expected.sampleId
      ));
      expect(assertionGroup?.entries.map((entry) => [
        entry.metricId,
        entry.criterionId,
        entry.rowStatus,
        entry.value,
      ]))
        .toEqual([
          ['contains-hello', 'contains-hello', 'observed', true],
          ['contains-missing', 'contains-missing', 'observed', false],
          ['cost-within-budget', 'cost-within-budget-criterion', 'observed', true],
          ['fact-set', 'fact-set', 'observed', true],
          ['llm-answer-relevancy-pass', 'answer-relevancy-criterion', 'observed', true],
          ['llm-context-recall-pass', 'context-recall-criterion', 'observed', false],
          ['llm-faithfulness-pass', 'faithfulness-criterion', 'observed', false],
          ['llm-semantic-similarity-pass', 'semantic-similarity-criterion', 'observed', true],
          ['short-enough', 'short-enough', 'observed', true],
        ]);
      expect(assertionGroup?.layers.fact.score).toBe(expected.layeredScores.factScore);
      expect(assertionGroup?.layers.behavior.score).toBe(expected.layeredScores.behaviorScore);
      expect(compositeGroup?.layers.map((layer) => [
        layer.binding.layerId,
        layer.layerStatus,
        layer.score,
      ]))
        .toEqual([
          ['fact', 'observed', expected.layeredScores.factScore],
          ['behavior', 'observed', expected.layeredScores.behaviorScore],
          ['judge', 'observed', expected.layeredScores.judgeScore],
        ]);
      expect(compositeGroup?.aggregate.score).toBe(expected.compositeScore);
    }

    const replicate = completedAnalysisValue(core, 'judge-replicate') as {
      groups: Array<{
        targetId: string;
        sampleId: string;
        ensembleMemberId: string;
        mean: number;
        sampleStddev: number;
        replicates: Array<{ replicateIndex: number; rowStatus: string; score: number }>;
      }>;
    };
    const ensemble = completedAnalysisValue(core, 'judge-ensemble') as {
      groups: Array<{
        targetId: string;
        sampleId: string;
        consensus: number;
        members: Array<{ ensembleMemberId: string; mean: number; sampleStddev: number }>;
        agreement: { agreementStatus: string; meanAbsDiff: number; pairCount: number };
      }>;
    };
    expect(replicate.groups).toHaveLength(16);
    expect(ensemble.groups).toHaveLength(8);
    for (const group of ensemble.groups) {
      const expected = legacy.coordinates.find((coordinate) => (
        coordinate.targetId === group.targetId && coordinate.sampleId === group.sampleId
      ));
      if (expected === undefined) throw new Error('Missing legacy judge coordinate.');
      expect(group.consensus).toBe(expected.judgeEnsemble.score);
      expect(group.members.map((member) => [
        member.ensembleMemberId,
        member.mean,
        member.sampleStddev,
      ])).toEqual(expected.judgeEnsemble.ensemble?.map((member) => [
        member.judge.split(':')[0],
        member.score,
        member.scoreStddev,
      ]));
      expect(group.agreement).toEqual({
        agreementStatus: 'observed',
        meanAbsDiff: expected.judgeEnsemble.agreement?.meanAbsDiff,
        pairCount: expected.judgeEnsemble.agreement?.pairCount,
      });
      const replicateGroups = replicate.groups.filter((candidate) => (
        candidate.targetId === group.targetId && candidate.sampleId === group.sampleId
      ));
      expect(replicateGroups.map((candidate) => ({
        member: candidate.ensembleMemberId,
        mean: candidate.mean,
        sampleStddev: candidate.sampleStddev,
        replicates: candidate.replicates.map((entry) => [
          entry.replicateIndex,
          entry.rowStatus,
          entry.score,
        ]),
      }))).toEqual(expected.judgeEnsemble.ensemble?.map((member) => ({
        member: member.judge.split(':')[0],
        mean: member.score,
        sampleStddev: member.scoreStddev,
        replicates: (member.scoreSamples ?? []).map((score, replicateIndex) => [
          replicateIndex,
          'observed',
          score,
        ]),
      })));
    }
    const dimension = completedAnalysisValue(core, 'dimension-table') as {
      groups: Array<{
        targetId: string;
        sampleId: string;
        dimensions: Array<{
          dimensionId: string;
          metricId: string;
          sourceAnalysisResultId: string;
          sourceGroupId: string;
          dimensionStatus: string;
          consensus: number;
        }>;
        coverage: { plannedDimensions: number; observedDimensions: number; missingDimensions: number };
        aggregate: { aggregateStatus: string; mean: number };
      }>;
    };
    expect(dimension.groups).toHaveLength(8);
    for (const group of dimension.groups) {
      const expected = legacy.coordinates.find((coordinate) => (
        coordinate.targetId === group.targetId && coordinate.sampleId === group.sampleId
      ));
      if (expected === undefined) throw new Error('Missing legacy dimension coordinate.');
      expect(group.coverage).toEqual({
        plannedDimensions: 1,
        observedDimensions: 1,
        missingDimensions: 0,
      });
      expect(group.aggregate).toEqual({
        aggregateStatus: 'observed',
        mean: expected.judgeScore,
      });
      expect(group.dimensions).toEqual([expect.objectContaining({
        dimensionId: 'correctness',
        metricId: 'rubric-score',
        sourceAnalysisResultId: 'judge-ensemble',
        sourceGroupId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        dimensionStatus: 'observed',
        consensus: expected.judgeScore,
      })]);
    }

    const bootstrap = completedAnalysisValue(core, 'bootstrap-family') as {
      comparisons: Array<{
        comparisonStatus: string;
        counts: { controlUnits: number; treatmentUnits: number; comparableUnits: number };
        includedSourceGroupIds: string[];
        interval: { lower: number; upper: number; estimate: number; samples: number; significant: boolean };
      }>;
    };
    expect(bootstrap.comparisons[0]).toMatchObject({
      comparisonStatus: 'observed',
      counts: { controlUnits: 4, treatmentUnits: 4, comparableUnits: 4 },
      interval: {
        lower: legacy.comparison.low,
        upper: legacy.comparison.high,
        estimate: legacy.comparison.estimate,
        samples: legacy.comparison.samples,
        significant: legacy.comparison.significant,
      },
    });
    expect(bootstrap.comparisons[0].includedSourceGroupIds).toHaveLength(8);
    const agreement = completedAnalysisValue(core, 'agreement-table') as {
      configuration: {
        source: { targetId: string };
        gold: { annotatorId: string; annotationVersion: string; contextPointer: string };
      };
      pairs: Array<{
        sampleId: string;
        gold: { ratingStatus: string; score: number };
        judge: { ratingStatus: string; score: number; sourceGroupIds: string[] };
      }>;
      coverage: { plannedPairs: number; comparablePairs: number };
      statistics: {
        krippendorffAlpha: { value: number };
        alphaInterval: { lower: number; upper: number; estimate: number; samples: number };
        weightedKappa: { value: number };
        pearson: { value: number };
      };
    };
    expect(agreement.statistics).toMatchObject({
      krippendorffAlpha: { value: legacy.agreement.alpha },
      alphaInterval: {
        lower: legacy.agreement.alphaCI.low,
        upper: legacy.agreement.alphaCI.high,
        estimate: legacy.agreement.alphaCI.estimate,
        samples: legacy.agreement.alphaCI.samples,
      },
      weightedKappa: { value: legacy.agreement.weightedKappa },
      pearson: { value: legacy.agreement.pearson },
    });
    expect(agreement.configuration).toMatchObject({
      source: { targetId: 'treatment' },
      gold: {
        annotatorId: 'human-a',
        annotationVersion: 'v1',
        contextPointer: '/goldScore',
      },
    });
    expect(agreement.coverage).toMatchObject({ plannedPairs: 4, comparablePairs: 4 });
    expect(agreement.pairs.map((pair) => ({
      sampleId: pair.sampleId,
      gold: pair.gold,
      judge: { ...pair.judge, sourceGroupIds: pair.judge.sourceGroupIds.length },
    }))).toEqual(SAMPLE_IDS.map((sampleId, index) => ({
      sampleId,
      gold: { ratingStatus: 'observed', score: index + 2 },
      judge: {
        ratingStatus: 'observed',
        score: RUBRIC_SCORES.treatment[index],
        sourceGroupIds: 1,
        coverage: { plannedGroups: 1, observedGroups: 1, missingGroups: 0 },
      },
    })));
    expect(core.artifacts.decision).toMatchObject({
      decisionStatus: 'decided',
      verdict: legacy.verdict.level,
      reasonCodes: ['comparison-significant-progress', 'release-gates-passed'],
    });
    expect(core.artifacts.decision?.analysisResultIds).toEqual([
      'bootstrap-family', 'composite-table', 'judge-ensemble',
    ]);
  });
});
