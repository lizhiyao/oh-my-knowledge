import {
  digestCanonicalJson,
  type AnalysisCohortDefinition,
  type AnalysisGraphDefinition,
  type DecisionPolicyDefinition,
  type EvaluationSample,
  type JsonValue,
  type MetricDefinition,
} from '../../evaluation-core/contracts/index.js';
import { DEFAULT_BOOTSTRAP_SEED } from '../../eval-core/bootstrap.js';
import { splitHoldout } from '../../eval-core/holdout.js';
import { renderEnvironmentSection } from '../../eval-core/task-planner.js';
import { deterministicAssertionInputSourceKinds } from '../../shared/assertions/deterministic.js';
import { resolveAssertionLayer } from '../../shared/assertions/layers.js';
import type { Assertion, Sample } from '../../types/index.js';
import type {
  CliEvaluationRequest,
  ResolvedEvaluatorTemplate,
  ResolvedJudgeMember,
} from '../input-compilation/index.js';
import {
  ASSERTION_LAYER_ANALYSIS_IMPLEMENTATION_ID,
  BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
  COMPOSITE_ANALYSIS_IMPLEMENTATION_ID,
  DIMENSION_ANALYSIS_IMPLEMENTATION_ID,
  JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID,
  JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
  RELEASE_DECISION_POLICY_IMPLEMENTATION_ID,
} from '../runtime-adapter/analysis/index.js';
import {
  EXECUTION_ASSERTION_BINDINGS,
  EXECUTION_ASSERTION_CONTEXT_SCHEMA_VERSION,
  EXECUTION_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
  LLM_ASSERTION_BINDINGS,
  LLM_ASSERTION_CONTEXT_SCHEMA_VERSION,
  LLM_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
  OUTPUT_ASSERTION_BINDINGS,
  OUTPUT_ASSERTION_CONTEXT_SCHEMA_VERSION,
  OUTPUT_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
  RUBRIC_JUDGE_BINDINGS,
  RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION,
  RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID,
  llmAssertionInstrument,
  rubricJudgeInstrument,
  rubricJudgeInstrumentId,
  type LlmAssertionType,
} from '../runtime-adapter/evaluators/index.js';
import { CliEvaluationInputError } from '../input-compilation/error.js';

const LLM_ASSERTION_TYPES = new Set<LlmAssertionType>([
  'semantic_similarity',
  'faithfulness',
  'answer_relevancy',
  'context_recall',
]);

interface CriterionDesign {
  readonly criterionId: string;
  readonly metricId: string;
  readonly layerDisposition: 'fact' | 'behavior' | 'excluded-mixed-layer';
  readonly weight: number;
}

export interface ProductionMeasurementDesign {
  readonly dataset: {
    readonly datasetId: string;
    readonly samples: readonly EvaluationSample[];
    readonly analysisCohorts?: readonly AnalysisCohortDefinition[];
  };
  readonly evaluatorTemplates: readonly ResolvedEvaluatorTemplate[];
  readonly judges: {
    readonly enabled: boolean;
    readonly members: readonly ResolvedJudgeMember[];
    readonly replicateCount: number;
  };
  readonly metrics: readonly MetricDefinition[];
  readonly analysisGraph: AnalysisGraphDefinition;
  readonly decisionPolicy?: DecisionPolicyDefinition;
}

function fail(fieldPath: string, message: string): never {
  throw new CliEvaluationInputError({
    code: 'CLI_INPUT_INVALID',
    fieldPath,
    message,
  });
}

function digestId(prefix: string, value: JsonValue): string {
  return `${prefix}-${digestCanonicalJson(value).slice('sha256:'.length, 'sha256:'.length + 16)}`;
}

function renderedPrompt(sample: Readonly<Sample>): string {
  const environment = renderEnvironmentSection(sample.environment);
  const prompt = sample.context
    ? `${sample.prompt}\n\n\`\`\`\n${sample.context}\n\`\`\``
    : sample.prompt;
  return environment === null ? prompt : `${environment}\n\n---\n\n${prompt}`;
}

function annotations(sample: Readonly<Sample>): JsonValue | undefined {
  const value: Record<string, JsonValue> = {};
  if (sample.capability !== undefined) value.capability = [...sample.capability];
  if (sample.difficulty !== undefined) value.difficulty = sample.difficulty;
  if (sample.construct !== undefined) value.construct = sample.construct;
  if (sample.provenance !== undefined) value.provenance = sample.provenance;
  if (sample.tripwire !== undefined) value.tripwire = sample.tripwire;
  if (sample.covers !== undefined) {
    value.covers = structuredClone(sample.covers) as unknown as JsonValue;
  }
  return Object.keys(value).length === 0 ? undefined : value;
}

function criterionIdentity(
  sampleId: string,
  assertion: Readonly<Assertion>,
  index: number,
): { criterionId: string; metricId: string } {
  const identity = { sampleId, assertion: assertion as unknown as JsonValue, index };
  return {
    criterionId: digestId('criterion', identity),
    metricId: digestId('assertion', identity),
  };
}

function metric(metricId: string, valueType: 'boolean' | 'numeric'): MetricDefinition {
  return {
    metricId,
    valueType,
    scope: 'sample',
    ...(valueType === 'numeric' ? { scale: { min: 1, max: 5 } } : {}),
    direction: 'higher-is-better',
    missingPolicyId: 'exclude/v1',
  };
}

function llmCriterion(
  type: LlmAssertionType,
  criterionId: string,
  assertion: Readonly<Assertion>,
  sample: Readonly<Sample>,
): JsonValue {
  const source = type === 'faithfulness'
    ? assertion.reference ?? sample.context
    : type === 'answer_relevancy'
      ? sample.prompt
      : assertion.reference ?? (type === 'context_recall' ? sample.context : undefined);
  if (source === undefined || source.trim() === '') {
    fail(
      `samples.${sample.sample_id}.assertions`,
      `LLM assertion「${type}」缺少可冻结的 reference／context／question。`,
    );
  }
  return {
    schemaVersion: LLM_ASSERTION_CONTEXT_SCHEMA_VERSION,
    criterionId,
    assertionType: type,
    threshold: assertion.threshold ?? 3,
    weight: assertion.weight ?? 1,
    negated: assertion.not ?? false,
    ...(type === 'faithfulness' ? { context: source }
      : type === 'answer_relevancy' ? { question: source }
        : { reference: source }),
  };
}

/** Converts legacy authoring DTOs once; no legacy object escapes this boundary. */
export function buildProductionMeasurementDesign(
  request: Readonly<CliEvaluationRequest>,
  sourceSamples: readonly Readonly<Sample>[],
): ProductionMeasurementDesign {
  if (sourceSamples.length === 0) fail('samples', 'Evaluation dataset 至少需要一个 sample。');
  const sortedSamples = [...sourceSamples].sort((left, right) => (
    left.sample_id < right.sample_id ? -1 : left.sample_id > right.sample_id ? 1 : 0
  ));
  const sampleIds = sortedSamples.map((sample) => sample.sample_id);
  if (new Set(sampleIds).size !== sampleIds.length) fail('samples[].sample_id', 'sampleId 不得重复。');

  const evaluationContexts = new Map<string, Record<string, JsonValue>>();
  const metrics: MetricDefinition[] = [];
  const criteria: CriterionDesign[] = [];
  const templates: ResolvedEvaluatorTemplate[] = [];
  const outputMetricIds: string[] = [];
  const outputCriteriaBySample = new Map<string, JsonValue[]>();
  const executionGroups = new Map<string, {
    readonly sourceKinds: readonly ('output' | 'execution-facts' | 'trace')[];
    readonly metricIds: string[];
    readonly criteriaBySample: Map<string, JsonValue[]>;
  }>();

  const contextFor = (sampleId: string): Record<string, JsonValue> => {
    const existing = evaluationContexts.get(sampleId);
    if (existing !== undefined) return existing;
    const created: Record<string, JsonValue> = {};
    evaluationContexts.set(sampleId, created);
    return created;
  };

  for (const sample of sortedSamples) {
    for (const [index, assertion] of (sample.assertions ?? []).entries()) {
      const identity = criterionIdentity(sample.sample_id, assertion, index);
      const layer = resolveAssertionLayer(assertion) ?? 'excluded-mixed-layer';
      const weight = assertion.weight ?? 1;
      if (LLM_ASSERTION_TYPES.has(assertion.type as LlmAssertionType)) {
        if (!request.values.judges.enabled) continue;
        const assertionType = assertion.type as LlmAssertionType;
        const instrument = llmAssertionInstrument(assertionType);
        const contextKey = digestId('llmCriterion', {
          sampleId: sample.sample_id,
          criterionId: identity.criterionId,
        });
        contextFor(sample.sample_id)[contextKey] = llmCriterion(
          assertionType,
          identity.criterionId,
          assertion,
          sample,
        );
        metrics.push(metric(identity.metricId, 'boolean'));
        criteria.push({ ...identity, layerDisposition: layer, weight });
        templates.push({
          evaluatorId: digestId('llm-assertion', { criterionId: identity.criterionId }),
          evaluatorKind: 'llm-rubric',
          runtimeBindingKind: 'judge',
          implementationId: LLM_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
          applicableSampleIds: [sample.sample_id],
          instrumentId: instrument.promptId,
          runtimePromptVariant: instrument.promptId,
          replicateGroupId: digestId('llm-assertion-group', {
            assertionType,
            criterionId: identity.criterionId,
          }),
          metricIds: [identity.metricId],
          inputs: [
            { bindingId: LLM_ASSERTION_BINDINGS.actual, sourceKind: 'output', pointer: '' },
            {
              bindingId: LLM_ASSERTION_BINDINGS.criterion,
              sourceKind: 'evaluation-context',
              pointer: `/${contextKey}`,
            },
          ],
          config: { classification: 'public', value: instrument as unknown as JsonValue },
        });
        continue;
      }
      if (assertion.type === 'custom') {
        fail(
          `samples.${sample.sample_id}.assertions.${index}`,
          'Evaluation Core production resolver 不接受进程内 custom assertion；请改用版本化 Evaluator。',
        );
      }
      const sourceKinds = deterministicAssertionInputSourceKinds(assertion);
      if (sourceKinds.length === 0) fail(
        `samples.${sample.sample_id}.assertions.${index}`,
        `Assertion 类型「${assertion.type}」没有受支持的确定性或 LLM Evaluator。`,
      );
      metrics.push(metric(identity.metricId, 'boolean'));
      criteria.push({ ...identity, layerDisposition: layer, weight });
      const criterion = {
        criterionId: identity.criterionId,
        metricId: identity.metricId,
        assertion: structuredClone(assertion) as unknown as JsonValue,
      };
      if (sourceKinds.length === 1 && sourceKinds[0] === 'output') {
        outputMetricIds.push(identity.metricId);
        const values = outputCriteriaBySample.get(sample.sample_id) ?? [];
        values.push(criterion);
        outputCriteriaBySample.set(sample.sample_id, values);
      } else {
        const signature = sourceKinds.join('+');
        const group: {
          readonly sourceKinds: readonly ('output' | 'execution-facts' | 'trace')[];
          readonly metricIds: string[];
          readonly criteriaBySample: Map<string, JsonValue[]>;
        } = executionGroups.get(signature) ?? {
          sourceKinds,
          metricIds: [] as string[],
          criteriaBySample: new Map<string, JsonValue[]>(),
        };
        group.metricIds.push(identity.metricId);
        const values = group.criteriaBySample.get(sample.sample_id) ?? [];
        values.push(criterion);
        group.criteriaBySample.set(sample.sample_id, values);
        executionGroups.set(signature, group);
      }
    }
  }

  if (outputMetricIds.length > 0) {
    for (const [sampleId, values] of outputCriteriaBySample) {
      contextFor(sampleId).outputAssertions = {
        schemaVersion: OUTPUT_ASSERTION_CONTEXT_SCHEMA_VERSION,
        criteria: values,
      };
    }
    templates.push({
      evaluatorId: 'output-assertions',
      evaluatorKind: 'assertion',
      runtimeBindingKind: 'builtin',
      implementationId: OUTPUT_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
      applicableSampleIds: [...outputCriteriaBySample.keys()].sort(),
      instrumentId: 'omk-output-assertions',
      replicateGroupId: 'deterministic-primary',
      metricIds: outputMetricIds,
      inputs: [
        { bindingId: OUTPUT_ASSERTION_BINDINGS.actual, sourceKind: 'output', pointer: '' },
        {
          bindingId: OUTPUT_ASSERTION_BINDINGS.criteria,
          sourceKind: 'evaluation-context',
          pointer: '/outputAssertions',
        },
      ],
    });
  }

  for (const [signature, group] of executionGroups) {
    const contextKey = digestId('executionAssertions', { signature });
    for (const [sampleId, values] of group.criteriaBySample) {
      contextFor(sampleId)[contextKey] = {
        schemaVersion: EXECUTION_ASSERTION_CONTEXT_SCHEMA_VERSION,
        sourceKinds: [...group.sourceKinds],
        criteria: values,
      };
    }
    templates.push({
      evaluatorId: `execution-assertions-${signature.replaceAll('+', '-')}`,
      evaluatorKind: 'assertion',
      runtimeBindingKind: 'builtin',
      implementationId: EXECUTION_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
      applicableSampleIds: [...group.criteriaBySample.keys()].sort(),
      instrumentId: `omk-execution-assertions-${signature.replaceAll('+', '-')}`,
      replicateGroupId: 'deterministic-primary',
      metricIds: group.metricIds,
      inputs: [
        ...(group.sourceKinds.includes('output') ? [{
          bindingId: EXECUTION_ASSERTION_BINDINGS.actual,
          sourceKind: 'output' as const,
          pointer: '',
        }] : []),
        ...(group.sourceKinds.includes('execution-facts') ? [{
          bindingId: EXECUTION_ASSERTION_BINDINGS.facts,
          sourceKind: 'execution-facts' as const,
          pointer: '',
        }] : []),
        ...(group.sourceKinds.includes('trace') ? [{
          bindingId: EXECUTION_ASSERTION_BINDINGS.trace,
          sourceKind: 'trace' as const,
          pointer: '',
        }] : []),
        {
          bindingId: EXECUTION_ASSERTION_BINDINGS.criteria,
          sourceKind: 'evaluation-context',
          pointer: `/${contextKey}`,
        },
      ],
    });
  }

  const rubricInstrument = rubricJudgeInstrument({
    lengthDebias: request.values.judges.lengthDebias,
    tracePolicy: 'source-neutral',
  });
  const rubricInstrumentId = rubricJudgeInstrumentId(rubricInstrument);
  const rubricDimensions = new Map<string, {
    dimensionId: string;
    metricId: string;
    sampleIds: Set<string>;
  }>();
  if (request.values.judges.enabled) {
    for (const sample of sortedSamples) {
      const dimensions = sample.dimensions
        ?? (sample.rubric === undefined ? {} : { overall: sample.rubric });
      for (const [dimensionName, rubric] of Object.entries(dimensions).sort((left, right) => (
        left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0
      ))) {
        const design = rubricDimensions.get(dimensionName) ?? {
          dimensionId: digestId('dimension', { dimensionName }),
          metricId: digestId('judge', { dimensionName }),
          sampleIds: new Set<string>(),
        };
        rubricDimensions.set(dimensionName, design);
        design.sampleIds.add(sample.sample_id);
        const contextKey = `rubricJudge_${design.metricId.replaceAll('-', '_')}`;
        contextFor(sample.sample_id)[contextKey] = {
          schemaVersion: RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION,
          criterionId: design.dimensionId,
          prompt: sample.prompt,
          rubric,
        };
      }
    }
  }
  for (const design of rubricDimensions.values()) {
    metrics.push(metric(design.metricId, 'numeric'));
    const contextKey = `rubricJudge_${design.metricId.replaceAll('-', '_')}`;
    templates.push({
      evaluatorId: `rubric-${design.dimensionId}`,
      evaluatorKind: 'llm-rubric',
      runtimeBindingKind: 'judge',
      implementationId: RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID,
      applicableSampleIds: [...design.sampleIds].sort(),
      instrumentId: rubricInstrumentId,
      runtimePromptVariant: rubricInstrument.promptId,
      replicateGroupId: `rubric-${design.dimensionId}`,
      metricIds: [design.metricId],
      inputs: [
        { bindingId: RUBRIC_JUDGE_BINDINGS.actual, sourceKind: 'output', pointer: '' },
        {
          bindingId: RUBRIC_JUDGE_BINDINGS.criterion,
          sourceKind: 'evaluation-context',
          pointer: `/${contextKey}`,
        },
        { bindingId: RUBRIC_JUDGE_BINDINGS.trace, sourceKind: 'trace', pointer: '' },
      ],
      config: { classification: 'public', value: rubricInstrument as unknown as JsonValue },
    });
  }

  if (metrics.length === 0) {
    fail('samples', 'Dataset 没有可测量的 assertion、rubric 或 dimension。');
  }

  const nodes: AnalysisGraphDefinition['nodes'][number][] = [];
  const compositeInputs: AnalysisGraphDefinition['nodes'][number]['inputs'] = [];
  const compositeLayers: JsonValue[] = [];
  if (criteria.length > 0) {
    nodes.push({
      analysisNodeKind: 'reducer',
      nodeId: 'assertion-layer',
      implementationId: ASSERTION_LAYER_ANALYSIS_IMPLEMENTATION_ID,
      inputs: criteria.map((criterion) => ({
        inputKind: 'metric-observations',
        referenceId: criterion.metricId,
      })),
      outputResultId: 'assertion-layer',
      parameters: {
        criteria: criteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          metricId: criterion.metricId,
          layerDisposition: criterion.layerDisposition,
          weight: criterion.weight,
        })),
      },
    });
    compositeInputs.push({ inputKind: 'analysis-result', referenceId: 'assertion-layer' });
    if (criteria.some((criterion) => criterion.layerDisposition === 'fact')) {
      compositeLayers.push({
        layerId: 'fact', analysisResultId: 'assertion-layer',
        sourceKind: 'assertion-layer', selector: 'fact',
      });
    }
    if (criteria.some((criterion) => criterion.layerDisposition === 'behavior')) {
      compositeLayers.push({
        layerId: 'behavior', analysisResultId: 'assertion-layer',
        sourceKind: 'assertion-layer', selector: 'behavior',
      });
    }
  }

  const dimensions: JsonValue[] = [];
  for (const design of rubricDimensions.values()) {
    const replicateResultId = `judge-replicate-${design.metricId}`;
    const ensembleResultId = `judge-ensemble-${design.metricId}`;
    nodes.push({
      analysisNodeKind: 'reducer',
      nodeId: replicateResultId,
      implementationId: JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
      inputs: [{ inputKind: 'metric-observations', referenceId: design.metricId }],
      outputResultId: replicateResultId,
    }, {
      analysisNodeKind: 'reducer',
      nodeId: ensembleResultId,
      implementationId: JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID,
      inputs: [{ inputKind: 'analysis-result', referenceId: replicateResultId }],
      outputResultId: ensembleResultId,
    });
    dimensions.push({
      dimensionId: design.dimensionId,
      metricId: design.metricId,
      analysisResultId: ensembleResultId,
    });
  }
  if (dimensions.length > 0) {
    nodes.push({
      analysisNodeKind: 'reducer',
      nodeId: 'dimension-table',
      implementationId: DIMENSION_ANALYSIS_IMPLEMENTATION_ID,
      inputs: dimensions.map((dimension) => ({
        inputKind: 'analysis-result',
        referenceId: (dimension as { analysisResultId: string }).analysisResultId,
      })),
      outputResultId: 'dimension-table',
      parameters: { dimensions },
    });
    compositeInputs.push({ inputKind: 'analysis-result', referenceId: 'dimension-table' });
    compositeLayers.push({
      layerId: 'judge', analysisResultId: 'dimension-table',
      sourceKind: 'dimension', selector: 'aggregate',
    });
  }
  if (compositeLayers.length === 0) {
    fail(
      'samples[].assertions',
      'Dataset 只有跨层 assertion，无法构造可解释的 composite；请明确 fact／behavior 归属。',
    );
  }
  nodes.push({
    analysisNodeKind: 'reducer',
    nodeId: 'composite-table',
    implementationId: COMPOSITE_ANALYSIS_IMPLEMENTATION_ID,
    inputs: compositeInputs,
    outputResultId: 'composite-table',
    parameters: { layers: compositeLayers },
  });

  const control = request.values.variants.find((variant) => variant.experimentRole === 'control');
  const treatments = request.values.variants.filter(
    (variant) => variant.experimentRole === 'treatment',
  );
  if (control === undefined || treatments.length === 0) {
    fail('variants', 'Measurement design 要求一个 control 和至少一个 treatment。');
  }
  const targetIds = request.values.variants.map((variant) => variant.targetId).sort();
  let decisionPolicy: DecisionPolicyDefinition | undefined;
  if (request.values.measurement.bootstrap.enabled) {
    nodes.push({
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
        targetIds,
        sampleIds,
        comparisons: treatments.map((target) => ({
          comparisonId: `control-vs-${target.targetId}`,
          controlTargetId: control.targetId,
          treatmentTargetId: target.targetId,
          comparisonDesign: 'paired',
        })),
        resamples: request.values.measurement.bootstrap.resamples,
        alpha: 0.05,
        seed: DEFAULT_BOOTSTRAP_SEED,
      },
    });
    const firstJudge = [...rubricDimensions.values()][0];
    const analysisResultIds = [
      'composite-table',
      'bootstrap-family',
      ...(firstJudge === undefined ? [] : [`judge-ensemble-${firstJudge.metricId}`]),
    ];
    const holdout = request.values.measurement.holdoutRatio === undefined
      ? null
      : splitHoldout(sampleIds, request.values.measurement.holdoutRatio);
    decisionPolicy = {
      decisionPolicyId: 'release-decision',
      implementationId: RELEASE_DECISION_POLICY_IMPLEMENTATION_ID,
      analysisResultIds,
      comparisonFamily: treatments.map((target) => ({
        comparisonId: `control-vs-${target.targetId}`,
        treatmentTargetId: target.targetId,
        metricId: firstJudge?.metricId ?? metrics[0]!.metricId,
        analysisResultId: 'bootstrap-family',
      })),
      comparisonFamilyResultId: 'bootstrap-family',
      minimumEvidenceStatus: 'complete',
      parameters: {
        sources: {
          compositeResultId: 'composite-table',
          bootstrapFamilyResultId: 'bootstrap-family',
          ...(firstJudge === undefined ? {} : {
            judgeEnsemble: {
              analysisResultId: `judge-ensemble-${firstJudge.metricId}`,
              metricId: firstJudge.metricId,
              instrumentId: rubricInstrumentId,
              replicateGroupId: `rubric-${firstJudge.dimensionId}`,
            },
          }),
        },
        targetIds,
        sampleIds,
        thresholds: {
          layerScore: request.values.measurement.decision.threshold ?? 3,
          triviallySmallDifference:
            request.values.measurement.decision.trivialDifference ?? 0.1,
          minimumSampleCount: 20,
          judgeDissentPearson: 0.4,
          holdoutGap: 0.5,
        },
        ...(holdout === null ? {} : {
          holdout: {
            trainSampleIds: sampleIds.filter((sampleId) => holdout.trainIds.has(sampleId)),
            holdoutSampleIds: sampleIds.filter((sampleId) => holdout.holdoutIds.has(sampleId)),
            minimumScorablePerPartition: 3,
          },
        }),
      },
    };
  }

  const holdout = request.values.measurement.holdoutRatio === undefined
    ? null
    : splitHoldout(sampleIds, request.values.measurement.holdoutRatio);
  const analysisCohorts = holdout === null ? undefined : [
    {
      cohortId: 'train',
      cohortSetId: 'holdout-split',
      cohortSetKind: 'partition',
      classification: 'gold',
      disclosure: 'identity-only',
      derivation: { algorithmId: 'omk.stride-holdout/v1', seed: 'canonical-sample-order' },
    },
    {
      cohortId: 'holdout',
      cohortSetId: 'holdout-split',
      cohortSetKind: 'partition',
      classification: 'gold',
      disclosure: 'identity-only',
      derivation: { algorithmId: 'omk.stride-holdout/v1', seed: 'canonical-sample-order' },
    },
  ] satisfies AnalysisCohortDefinition[];
  const samples: EvaluationSample[] = sortedSamples.map((sample) => {
    const evaluationContext = evaluationContexts.get(sample.sample_id);
    const sampleAnnotations = annotations(sample);
    return {
      sampleId: sample.sample_id,
      input: renderedPrompt(sample),
      ...(evaluationContext === undefined || Object.keys(evaluationContext).length === 0
        ? {}
        : { evaluationContext }),
      ...(holdout === null ? {} : {
        analysis: {
          memberships: [{
            cohortId: holdout.holdoutIds.has(sample.sample_id) ? 'holdout' : 'train',
          }],
        },
      }),
      ...(sampleAnnotations === undefined ? {} : { annotations: sampleAnnotations }),
    };
  });
  const judgeOccurrences = new Map<string, number>();
  const judges: ResolvedJudgeMember[] = [...request.values.judges.members]
    .sort((left, right) => (
      left.executorId < right.executorId ? -1 : left.executorId > right.executorId ? 1
        : left.model < right.model ? -1 : left.model > right.model ? 1 : 0
    ))
    .map((member) => {
      const identity = `${member.executorId}\u0000${member.model}`;
      const occurrence = judgeOccurrences.get(identity) ?? 0;
      judgeOccurrences.set(identity, occurrence + 1);
      return {
        ensembleMemberId: digestId('judge-member', {
          executorId: member.executorId,
          model: member.model,
          occurrence,
        }),
        executorId: member.executorId,
        model: member.model,
        effort: request.values.targetRuntime.effort,
      };
    });
  return {
    dataset: {
      datasetId: digestId('dataset', samples as unknown as JsonValue),
      samples,
      ...(analysisCohorts === undefined ? {} : { analysisCohorts }),
    },
    evaluatorTemplates: templates,
    judges: {
      enabled: request.values.judges.enabled,
      members: judges,
      replicateCount: request.values.judges.replicateCount,
    },
    metrics,
    analysisGraph: { analysisMode: 'preregistered', nodes },
    ...(decisionPolicy === undefined ? {} : { decisionPolicy }),
  };
}
