import {
  type AnalysisRequest,
  type Comparison,
  type Experiment,
  type Decision,
} from './contracts.js';
import {
  type JsonValue,
  digestCanonicalJson,
  type EvaluationDefinition,
  canonicalizeJson,
  MetricDefinitionSchema,
  JsonValueSchema,
  bonferroniMarginalAlpha,
  bonferroniMarginalConfidenceLevel,
  EvaluationDefinitionSchema,
  EVALUATION_DEFINITION_SCHEMA_VERSION,
  deepFreezeCanonicalJson,
} from '../../eval-core/contracts/index.js';
import {
  type CapturedVariant,
} from './capture-input.js';
import {
  evaluationExecutionControls,
} from '../execution-controls.js';
import {
  type CapturedEvaluators,
} from './capture-evaluators.js';
import {
  compareStrings,
} from './ordering.js';
import {
  configurationFailure,
} from './errors.js';
import {
  ComparisonInputSchema,
  AnalysesInputSchema,
  CohortFilterInputSchema,
  DecisionInputSchema,
} from './schemas.js';
import {
  z,
} from 'zod';

interface AnalysisBinding {
  readonly analysisId: string;
  readonly analysisKind: AnalysisRequest['analysisKind'];
  readonly resultId: string;
  readonly metricId: string;
  readonly variantId?: string;
  readonly comparisonId?: string;
  readonly treatmentVariantId?: string;
}

function stableFacadeId(
  identityKind: 'node' | 'decision' | 'slot',
  selector: Readonly<Record<string, JsonValue>>,
): string {
  return `${identityKind}:${digestCanonicalJson({
    derivation: 'omk.eval-runtime.definition-binding/v1',
    selector,
  }).slice('sha256:'.length)}`;
}

function targetDefinition(variant: Readonly<CapturedVariant>) {
  const executionControls = evaluationExecutionControls(
    variant.workspace,
    variant.allowedTools,
    variant.mcpConfig,
    variant.mockInterception,
  );
  return {
    targetId: variant.variantId,
    targetKind: variant.artifact.kind,
    protocolId: variant.executor.protocolId,
    executorId: variant.executor.declaration.executorId,
    executionRequirements: {
      systemInstructions: 'not-required' as const,
      workspace: variant.workspace === undefined
        ? 'not-required' as const
        : 'copy-on-write-overlay' as const,
      mcp: variant.mcpConfig === undefined
        ? 'not-required' as const
        : 'native-config' as const,
      mockInterception: variant.mockInterception === undefined
        ? 'not-required' as const
        : 'pre-tool-call' as const,
      toolPolicy: variant.allowedTools === undefined
        ? 'runtime-default' as const
        : 'allow-list' as const,
      skillDiscovery: 'runtime-default' as const,
    },
    executionControls,
    config: variant.envelope,
  };
}

function alphaFromConfidenceLevel(level: number): number {
  return Number((1 - level).toPrecision(15));
}

export function createGeneralDefinition(input: Readonly<{
  variants: readonly Readonly<CapturedVariant>[];
  evaluators: CapturedEvaluators;
  comparisons: readonly Comparison[];
  experiment: Experiment;
  analyses: readonly AnalysisRequest[];
  decision?: Decision;
}>): EvaluationDefinition {
  const variants = [...input.variants].sort((left, right) => (
    compareStrings(left.variantId, right.variantId)
  ));
  const variantIds = variants.map((variant) => variant.variantId);
  if (new Set(variantIds).size !== variantIds.length) {
    return configurationFailure(
      'EVAL_RUNTIME_VARIANT_INVALID',
      'Evaluation variantId 必须唯一。',
    );
  }
  const metrics = [...input.evaluators.metrics];
  const declaredCompositeMetricIds = new Set(input.analyses.flatMap((request) => (
    request.analysisKind === 'composite-quality-interval'
      || request.analysisKind === 'composite-comparison-interval'
      ? [request.compositeMetricId]
      : []
  )));
  const metricIds = new Set([
    ...metrics.map((metric) => metric.metricId),
    ...declaredCompositeMetricIds,
  ]);
  let comparisons: Comparison[];
  try {
    comparisons = input.comparisons.map((comparison) => (
      ComparisonInputSchema.parse(structuredClone(comparison))
    )).sort((left, right) => compareStrings(left.comparisonId, right.comparisonId));
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation comparisons declaration 无效。',
    );
  }
  if (new Set(comparisons.map((comparison) => comparison.comparisonId)).size
      !== comparisons.length) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation comparisonId 必须唯一。',
    );
  }
  const variantIdSet = new Set(variantIds);
  for (const comparison of comparisons) {
    const treatmentIds = new Set(comparison.treatmentVariantIds);
    if (!variantIdSet.has(comparison.controlVariantId)
        || treatmentIds.size !== comparison.treatmentVariantIds.length
        || treatmentIds.has(comparison.controlVariantId)
        || [...treatmentIds].some((variantId) => !variantIdSet.has(variantId))
        || new Set(comparison.metricIds).size !== comparison.metricIds.length
        || comparison.metricIds.some((metricId) => !metricIds.has(metricId))) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Evaluation comparison 引用了无效或重复的 Variant／Metric。',
      );
    }
  }
  const sampling = input.experiment.sampling;
  const isClustered = sampling.samplingKind === 'solo' && sampling.clusterKey !== undefined;
  if (sampling.samplingKind === 'solo') {
    if (variants.length !== 1 || comparisons.length !== 0) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'solo sampling 要求恰好一个 Variant，且不声明 Comparison。',
      );
    }
  } else {
    const participatingVariantIds = new Set(comparisons.flatMap((comparison) => [
      comparison.controlVariantId,
      ...comparison.treatmentVariantIds,
    ]));
    if (variants.length < 2 || comparisons.length === 0
        || variantIds.some((variantId) => !participatingVariantIds.has(variantId))) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        `${sampling.samplingKind} sampling 要求至少两个 Variant，且每个 Variant 都进入显式 Comparison。`,
      );
    }
    if (sampling.samplingKind === 'independent') {
      const allocationIds = sampling.allocations.map((allocation) => allocation.variantId);
      if (new Set(allocationIds).size !== allocationIds.length
          || [...allocationIds].sort(compareStrings).join('\u0000')
            !== [...variantIds].sort(compareStrings).join('\u0000')) {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'independent allocations 必须恰好声明每个 Variant 一次。',
        );
      }
    }
  }
  let analyses: z.infer<typeof AnalysesInputSchema>;
  try {
    analyses = AnalysesInputSchema.parse(structuredClone(input.analyses));
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation analysis declaration 无效。',
    );
  }
  const requests = [...analyses].sort((left, right) => (
    compareStrings(left.analysisId, right.analysisId)
  ));
  const declaredAnalysisIds = requests.flatMap((request) => [
    request.analysisId,
    ...(request.analysisKind === 'comparison-family'
      ? request.members.map((member) => member.analysisId)
      : []),
  ]);
  if (new Set(declaredAnalysisIds).size !== declaredAnalysisIds.length) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation analysisId 必须唯一。',
    );
  }
  const sourceMetricsById = new Map(input.evaluators.metrics.map((metric) => [
    metric.metricId,
    metric,
  ]));
  const compositeContractById = new Map<string, string>();
  for (const request of requests) {
    if (request.analysisKind !== 'composite-quality-interval'
        && request.analysisKind !== 'composite-comparison-interval') continue;
    const components = [...request.components].sort((left, right) => (
      compareStrings(left.metricId, right.metricId)
    ));
    const componentIds = components.map((component) => component.metricId);
    const totalWeight = components.reduce((sum, component) => sum + component.weight, 0);
    const sourcesSupported = components.every((component) => {
      const metric = sourceMetricsById.get(component.metricId);
      if (metric === undefined || metric.scope !== 'sample'
          || metric.missingPolicyId !== 'exclude/v1'
          || (metric.direction !== 'higher-is-better'
            && metric.direction !== 'lower-is-better')) return false;
      return metric.valueType === 'boolean'
        || (metric.valueType === 'numeric'
          && typeof metric.scale?.min === 'number'
          && Number.isFinite(metric.scale.min)
          && typeof metric.scale.max === 'number'
          && Number.isFinite(metric.scale.max)
          && metric.scale.min < metric.scale.max
          && metric.scale.target === undefined);
    });
    if (sourceMetricsById.has(request.compositeMetricId)
        || componentIds.length < 2
        || new Set(componentIds).size !== componentIds.length
        || componentIds.includes(request.compositeMetricId)
        || totalWeight !== 1
        || !sourcesSupported) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Composite analysis 要求唯一的 derived Metric、至少两个受支持 source Metric，以及严格求和为一的正权重。',
      );
    }
    const contract = canonicalizeJson({
      components,
      aggregation: request.aggregation,
    });
    const existing = compositeContractById.get(request.compositeMetricId);
    if (existing !== undefined && existing !== contract) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        '同一 compositeMetricId 在一次 Evaluation 中必须声明完全一致的 construct。',
      );
    }
    compositeContractById.set(request.compositeMetricId, contract);
  }
  const compositeComparisonBindings = new Set(requests.flatMap((request) => (
    request.analysisKind === 'composite-comparison-interval'
      ? [canonicalizeJson([request.comparisonId, request.compositeMetricId])]
      : []
  )));
  for (const comparison of comparisons) {
    if (comparison.metricIds.some((metricId) => (
      compositeContractById.has(metricId)
      && !compositeComparisonBindings.has(canonicalizeJson([
        comparison.comparisonId,
        metricId,
      ]))
    ))) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Derived composite Metric 只能绑定到声明它的 composite comparison。',
      );
    }
  }
  for (const compositeMetricId of [...compositeContractById.keys()].sort(compareStrings)) {
    metrics.push(MetricDefinitionSchema.parse({
      metricId: compositeMetricId,
      valueType: 'numeric',
      scope: 'sample',
      scale: { min: 0, max: 1 },
      unit: 'utility',
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    }));
  }
  const cohortIds = new Set(
    (input.evaluators.dataset.analysisCohorts ?? []).map((cohort) => cohort.cohortId),
  );
  const analysisNodes: EvaluationDefinition['analysisGraph']['nodes'] = [];
  const analysisBindings: AnalysisBinding[] = [];
  type CanonicalCohortFilter = Readonly<{
    includeCohortIds?: string[];
    excludeCohortIds?: string[];
  }>;
  const canonicalCohortFilter = (
    filter: z.infer<typeof CohortFilterInputSchema> | undefined,
  ): CanonicalCohortFilter | undefined => {
    const selectedCohortIds = [
      ...(filter?.includeCohortIds ?? []),
      ...(filter?.excludeCohortIds ?? []),
    ];
    if (new Set(selectedCohortIds).size !== selectedCohortIds.length
        || selectedCohortIds.some((cohortId) => !cohortIds.has(cohortId))) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Evaluation analysis 引用了未知或重复的 cohort。',
      );
    }
    if (filter?.includeCohortIds?.some((cohortId) => (
      filter.excludeCohortIds?.includes(cohortId)
    ))) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Evaluation analysis 不能同时包含并排除同一个 cohort。',
      );
    }
    return filter === undefined ? undefined : {
      ...(filter.includeCohortIds === undefined ? {} : {
        includeCohortIds: [...filter.includeCohortIds].sort(compareStrings),
      }),
      ...(filter.excludeCohortIds === undefined ? {} : {
        excludeCohortIds: [...filter.excludeCohortIds].sort(compareStrings),
      }),
    };
  };
  const addComparisonInterval = (
    selector: Readonly<{
      analysisId: string;
      comparisonId: string;
      treatmentVariantId: string;
      metricId: string;
    }>,
    parameters: Readonly<{ alpha: number; resamples: number }>,
    cohortFilter: CanonicalCohortFilter | undefined,
  ): void => {
    const metric = sourceMetricsById.get(selector.metricId);
    if (metric === undefined
        || (metric.valueType !== 'numeric' && metric.valueType !== 'boolean')) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Evaluation comparison interval 只接受已声明的 numeric 或 boolean Metric。',
      );
    }
    const comparison = comparisons.find((candidate) => (
      candidate.comparisonId === selector.comparisonId
    ));
    if (comparison === undefined
        || !comparison.treatmentVariantIds.includes(selector.treatmentVariantId)
        || !comparison.metricIds.includes(selector.metricId)) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Evaluation comparison interval 引用了未知 Comparison、Treatment 或 Metric。',
      );
    }
    const measurementAggregation = input.evaluators.measurementAggregations.get(selector.metricId);
    analysisNodes.push({
      analysisNodeKind: 'estimator',
      nodeId: stableFacadeId('node', { analysisId: selector.analysisId }),
      implementationId: sampling.samplingKind === 'independent'
        ? measurementAggregation === undefined
          ? 'bootstrap.unpaired-difference-percentile/v1'
          : 'bootstrap.hierarchical-unpaired-difference-percentile/v1'
        : measurementAggregation === undefined
          ? 'bootstrap.paired-difference-percentile/v1'
          : 'bootstrap.hierarchical-paired-difference-percentile/v1',
      inputs: [{
        inputKind: 'metric-observations',
        referenceId: selector.metricId,
      }, {
        inputKind: 'comparison',
        referenceId: selector.comparisonId,
        treatmentTargetId: selector.treatmentVariantId,
        metricId: selector.metricId,
      }],
      outputResultId: selector.analysisId,
      ...(cohortFilter === undefined ? {} : { cohortFilter }),
      parameters: {
        ...parameters,
        ...(measurementAggregation === undefined ? {} : {
          measurementAggregation: JsonValueSchema.parse(
            structuredClone(measurementAggregation),
          ),
        }),
      },
    });
    analysisBindings.push({
      analysisId: selector.analysisId,
      analysisKind: 'comparison-interval',
      resultId: selector.analysisId,
      metricId: selector.metricId,
      comparisonId: selector.comparisonId,
      treatmentVariantId: selector.treatmentVariantId,
    });
  };
  for (const request of requests) {
    const cohortFilter = canonicalCohortFilter(request.cohortFilter);
    if (request.analysisKind === 'comparison-family') {
      const members = [...request.members].sort((left, right) => (
        compareStrings(left.analysisId, right.analysisId)
      ));
      const contrastSelectors = members.map((member) => canonicalizeJson([
        member.comparisonId,
        member.treatmentVariantId,
        member.metricId,
      ]));
      if (new Set(contrastSelectors).size !== contrastSelectors.length) {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Evaluation comparison family 不能重复声明同一个 contrast。',
        );
      }
      let alpha: number;
      try {
        alpha = bonferroniMarginalAlpha(request.confidence.level, members.length);
        bonferroniMarginalConfidenceLevel(request.confidence.level, members.length);
      } catch {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Evaluation comparison family 无法表示有效的边际置信度。',
        );
      }
      for (const member of members) {
        addComparisonInterval(
          member,
          { alpha, resamples: request.confidence.resamples },
          cohortFilter,
        );
      }
      analysisNodes.push({
        analysisNodeKind: 'correction',
        nodeId: stableFacadeId('node', { analysisId: request.analysisId }),
        implementationId: 'simultaneous-intervals.bonferroni/v1',
        inputs: members.map((member) => ({
          inputKind: 'analysis-result',
          referenceId: member.analysisId,
        })),
        outputResultId: request.analysisId,
        parameters: {
          familyConfidenceLevel: request.confidence.level,
          resamples: request.confidence.resamples,
        },
      });
      continue;
    }
    if (request.analysisKind === 'composite-quality-interval'
        || request.analysisKind === 'composite-comparison-interval') {
      const components = [...request.components].sort((left, right) => (
        compareStrings(left.metricId, right.metricId)
      ));
      const parameters = {
        compositeMetricId: request.compositeMetricId,
        components: components.map((component) => {
          const measurementAggregation = input.evaluators.measurementAggregations.get(
            component.metricId,
          );
          return {
            metricId: component.metricId,
            weight: component.weight,
            ...(measurementAggregation === undefined ? {} : {
              measurementAggregation: JsonValueSchema.parse(
                structuredClone(measurementAggregation),
              ),
            }),
          };
        }),
        aggregation: request.aggregation,
        resamples: request.confidence.resamples,
        alpha: alphaFromConfidenceLevel(request.confidence.level),
      };
      const common = {
        analysisNodeKind: 'estimator' as const,
        nodeId: stableFacadeId('node', { analysisId: request.analysisId }),
        inputs: components.map((component) => ({
          inputKind: 'metric-observations' as const,
          referenceId: component.metricId,
        })),
        outputResultId: request.analysisId,
        ...(cohortFilter === undefined ? {} : { cohortFilter }),
        parameters,
      };
      if (request.analysisKind === 'composite-quality-interval') {
        if (!variantIdSet.has(request.variantId)) {
          return configurationFailure(
            'EVAL_RUNTIME_INPUT_INVALID',
            'Composite quality interval 引用了未知 Variant。',
          );
        }
        analysisNodes.push({
          ...common,
          targetFilter: { includeTargetIds: [request.variantId] },
          implementationId: isClustered
            ? 'bootstrap.composite-cluster-percentile/v1'
            : 'bootstrap.composite-mean-percentile/v1',
        });
        analysisBindings.push({
          analysisId: request.analysisId,
          analysisKind: request.analysisKind,
          resultId: request.analysisId,
          metricId: request.compositeMetricId,
          variantId: request.variantId,
        });
        continue;
      }
      const comparison = comparisons.find((candidate) => (
        candidate.comparisonId === request.comparisonId
      ));
      if (sampling.samplingKind === 'solo'
          || comparison === undefined
          || !comparison.treatmentVariantIds.includes(request.treatmentVariantId)) {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Composite comparison interval 要求 paired 或 independent sampling，以及有效的 Comparison 与 Treatment。',
        );
      }
      analysisNodes.push({
        ...common,
        implementationId: sampling.samplingKind === 'independent'
          ? 'bootstrap.composite-unpaired-difference-percentile/v1'
          : 'bootstrap.composite-paired-difference-percentile/v1',
        inputs: [...common.inputs, {
          inputKind: 'comparison',
          referenceId: request.comparisonId,
          treatmentTargetId: request.treatmentVariantId,
          metricId: request.compositeMetricId,
        }],
      });
      analysisBindings.push({
        analysisId: request.analysisId,
        analysisKind: request.analysisKind,
        resultId: request.analysisId,
        metricId: request.compositeMetricId,
        comparisonId: request.comparisonId,
        treatmentVariantId: request.treatmentVariantId,
      });
      continue;
    }
    const metric = sourceMetricsById.get(request.metricId);
    if (metric === undefined) {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Evaluation analysis 引用了未知 Metric。',
      );
    }
    const resultId = request.analysisId;
    const common = {
      nodeId: stableFacadeId('node', { analysisId: request.analysisId }),
      inputs: [{ inputKind: 'metric-observations' as const, referenceId: request.metricId }],
      outputResultId: resultId,
      ...(cohortFilter === undefined ? {} : {
        cohortFilter,
      }),
    };
    const measurementAggregation = input.evaluators.measurementAggregations.get(request.metricId);
    if (request.analysisKind === 'summary') {
      if (!variantIdSet.has(request.variantId)
          || (request.statistic === 'mean' && metric.valueType !== 'numeric')
          || (request.statistic === 'rate' && metric.valueType !== 'boolean')
          || (request.statistic === 'quantile' && metric.valueType !== 'numeric')
          || (request.statistic === 'quantile') !== (request.probability !== undefined)) {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Evaluation summary 的 Variant、Metric、statistic 或 probability 不匹配。',
        );
      }
      analysisNodes.push({
        ...common,
        analysisNodeKind: 'reducer',
        targetFilter: { includeTargetIds: [request.variantId] },
        implementationId: measurementAggregation === undefined
          ? `descriptive.${request.statistic}/v1`
          : `descriptive.hierarchical-${request.statistic}/v1`,
        parameters: {
          ...(request.statistic === 'quantile'
            ? { probability: request.probability as number }
            : {}),
          ...(measurementAggregation === undefined ? {} : {
            measurementAggregation: JsonValueSchema.parse(
              structuredClone(measurementAggregation),
            ),
          }),
        },
      });
      analysisBindings.push({
        analysisId: request.analysisId,
        analysisKind: request.analysisKind,
        resultId,
        metricId: request.metricId,
        variantId: request.variantId,
      });
      continue;
    }
    if (metric.valueType !== 'numeric' && metric.valueType !== 'boolean') {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Evaluation interval 只接受 numeric 或 boolean Metric。',
      );
    }
    const parameters = {
      resamples: request.confidence.resamples,
      alpha: alphaFromConfidenceLevel(request.confidence.level),
      ...(measurementAggregation === undefined ? {} : {
        measurementAggregation: JsonValueSchema.parse(structuredClone(measurementAggregation)),
      }),
    };
    if (request.analysisKind === 'quality-interval') {
      if (!variantIdSet.has(request.variantId)) {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Evaluation quality interval 引用了未知 Variant。',
        );
      }
      analysisNodes.push({
        ...common,
        analysisNodeKind: 'estimator',
        targetFilter: { includeTargetIds: [request.variantId] },
        implementationId: isClustered
          ? measurementAggregation === undefined
            ? 'bootstrap.cluster-percentile/v1'
            : 'bootstrap.hierarchical-cluster-percentile/v1'
          : measurementAggregation === undefined
            ? 'bootstrap.mean-percentile/v1'
            : 'bootstrap.hierarchical-mean-percentile/v1',
        parameters,
      });
      analysisBindings.push({
        analysisId: request.analysisId,
        analysisKind: request.analysisKind,
        resultId,
        metricId: request.metricId,
        variantId: request.variantId,
      });
      continue;
    }
    addComparisonInterval(request, parameters, cohortFilter);
  }
  let decisionPolicy;
  if (input.decision !== undefined) {
    let parsedDecision: z.infer<typeof DecisionInputSchema>;
    try {
      parsedDecision = DecisionInputSchema.parse(structuredClone(input.decision));
    } catch {
      return configurationFailure(
        'EVAL_RUNTIME_INPUT_INVALID',
        'Evaluation decision declaration 无效。',
      );
    }
    if (parsedDecision.decisionKind === 'comparison-family') {
      const family = requests.find((request) => (
        request.analysisId === parsedDecision.analysisId
        && request.analysisKind === 'comparison-family'
      ));
      if (family === undefined || family.analysisKind !== 'comparison-family') {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Evaluation comparison-family decision 必须精确选择一个 comparison-family analysis。',
        );
      }
      const criteria = [...parsedDecision.criteria].sort((left, right) => (
        compareStrings(left.analysisId, right.analysisId)
      ));
      const criterionIds = criteria.map((criterion) => criterion.analysisId);
      const memberIds = [...family.members]
        .map((member) => member.analysisId)
        .sort(compareStrings);
      if (new Set(criterionIds).size !== criterionIds.length
          || canonicalizeJson(criterionIds) !== canonicalizeJson(memberIds)) {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Evaluation comparison-family decision criteria 必须恰好覆盖全部 family member。',
        );
      }
      const members = [...family.members].sort((left, right) => (
        compareStrings(left.analysisId, right.analysisId)
      ));
      decisionPolicy = {
        decisionPolicyId: stableFacadeId('decision', {
          decisionKind: parsedDecision.decisionKind,
          resultId: family.analysisId,
        }),
        implementationId: 'release-family/v1',
        analysisResultIds: [family.analysisId],
        comparisonFamily: members.map((member) => ({
          comparisonId: member.comparisonId,
          treatmentTargetId: member.treatmentVariantId,
          metricId: member.metricId,
          analysisResultId: member.analysisId,
        })),
        comparisonFamilyResultId: family.analysisId,
        multipleComparisonPolicyId: 'simultaneous-intervals.bonferroni/v1',
        minimumEvidenceStatus: parsedDecision.minimumEvidenceStatus ?? 'complete',
        parameters: {
          rule: parsedDecision.rule,
          criteria: criteria.map((criterion) => ({
            analysisResultId: criterion.analysisId,
            ...(criterion.minimumEffect === undefined ? {} : {
              minimumEffect: criterion.minimumEffect,
            }),
            ...(criterion.maximumEffect === undefined ? {} : {
              maximumEffect: criterion.maximumEffect,
            }),
          })),
        },
      };
    } else {
      const selected = analysisBindings.filter((binding) => (
        binding.analysisId === parsedDecision.analysisId
      ));
      if (selected.length !== 1
          || (selected[0].analysisKind !== 'quality-interval'
            && selected[0].analysisKind !== 'comparison-interval'
            && selected[0].analysisKind !== 'composite-quality-interval'
            && selected[0].analysisKind !== 'composite-comparison-interval')) {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Evaluation decision 必须精确选择一个 interval analysis。',
        );
      }
      const chosen = selected[0];
      const decisionMetric = metrics.find((metric) => metric.metricId === chosen.metricId);
      if (decisionMetric?.direction !== 'higher-is-better') {
        return configurationFailure(
          'EVAL_RUNTIME_INPUT_INVALID',
          'Canonical progress Decision 只接受 higher-is-better Metric。',
        );
      }
      decisionPolicy = {
        decisionPolicyId: stableFacadeId('decision', {
          decisionKind: parsedDecision.decisionKind,
          resultId: chosen.resultId,
        }),
        implementationId: 'progress/v2',
        analysisResultIds: [chosen.resultId],
        ...(chosen.comparisonId === undefined ? {} : {
          comparisonFamily: [{
            comparisonId: chosen.comparisonId,
            treatmentTargetId: chosen.treatmentVariantId as string,
            metricId: chosen.metricId,
            analysisResultId: chosen.resultId,
          }],
        }),
        minimumEvidenceStatus: parsedDecision.minimumEvidenceStatus ?? 'complete',
        parameters: {
          threshold: parsedDecision.threshold ?? 0,
          equivalence: parsedDecision.equivalence ?? 0,
        },
      };
    }
  }
  const trials = input.experiment.trials ?? 1;
  const hasHierarchicalMeasurement = input.evaluators.measurementAggregations.size > 0;
  const estimatorId = sampling.samplingKind === 'solo'
    ? isClustered
      ? hasHierarchicalMeasurement
        ? 'bootstrap.hierarchical-cluster-percentile/v1'
        : 'bootstrap.cluster-percentile/v1'
      : hasHierarchicalMeasurement
        ? 'bootstrap.hierarchical-mean-percentile/v1'
        : 'bootstrap.mean-percentile/v1'
    : sampling.samplingKind === 'independent'
      ? hasHierarchicalMeasurement
        ? 'bootstrap.hierarchical-unpaired-difference-percentile/v1'
        : 'bootstrap.unpaired-difference-percentile/v1'
      : hasHierarchicalMeasurement
        ? 'bootstrap.hierarchical-paired-difference-percentile/v1'
        : 'bootstrap.paired-difference-percentile/v1';
  const randomizationSlots = variants.map((variant) => ({
    targetId: variant.variantId,
    randomizationSlotId: stableFacadeId('slot', { variantId: variant.variantId }),
  })).sort((left, right) => compareStrings(
    left.randomizationSlotId,
    right.randomizationSlotId,
  ));
  const slotByVariant = new Map(randomizationSlots.map((slot) => (
    [slot.targetId, slot.randomizationSlotId] as const
  )));
  const derivedComparisonMetricIds = new Map<string, Set<string>>();
  for (const request of requests) {
    if (request.analysisKind !== 'composite-comparison-interval') continue;
    const ids = derivedComparisonMetricIds.get(request.comparisonId) ?? new Set<string>();
    ids.add(request.compositeMetricId);
    derivedComparisonMetricIds.set(request.comparisonId, ids);
  }
  const definition = EvaluationDefinitionSchema.parse({
    schemaVersion: EVALUATION_DEFINITION_SCHEMA_VERSION,
    dataset: input.evaluators.dataset,
    targets: variants.map(targetDefinition),
    evaluators: input.evaluators.definitions,
    metrics,
    experiment: {
      trials,
      seed: input.experiment.seed,
      assignment: sampling.samplingKind === 'independent' ? {
        assignmentKind: 'independent-groups',
        algorithmId: 'assignment.stratified-fixed-quota/v1',
        ...(sampling.stratumKey === undefined ? {} : { stratumKey: sampling.stratumKey }),
        allocations: sampling.allocations.map((allocation) => {
          const randomizationSlotId = slotByVariant.get(allocation.variantId);
          if (randomizationSlotId === undefined) {
            return configurationFailure(
              'EVAL_RUNTIME_INPUT_INVALID',
              'independent allocation 引用了未知 Variant。',
            );
          }
          return { randomizationSlotId, weight: allocation.weight };
        }).sort((left, right) => compareStrings(
          left.randomizationSlotId,
          right.randomizationSlotId,
        )),
        minimumUnitsPerTarget: sampling.minimumSamplesPerVariant,
        minimumUnitsPerTargetPerStratum: sampling.minimumSamplesPerVariantPerStratum,
      } : {
        assignmentKind: 'complete-block',
        algorithmId: 'assignment.complete-block/v1',
        ...(sampling.stratumKey === undefined ? {} : { stratumKey: sampling.stratumKey }),
        randomizationSlotIds: randomizationSlots.map((slot) => slot.randomizationSlotId),
      },
      sampling: sampling.samplingKind === 'solo' ? {
        experimentalUnit: isClustered ? 'cluster' : 'sample',
        ...(sampling.clusterKey === undefined ? {} : { clusterKey: sampling.clusterKey }),
        repeatedMeasures: trials > 1,
        resamplingUnit: isClustered ? 'cluster' : 'sample',
        estimatorId,
        seedCoupling: 'independent-by-target',
      } : {
        experimentalUnit: 'sample',
        ...(sampling.samplingKind === 'paired'
          ? { pairingKey: sampling.pairingKey ?? '/sampleId' }
          : {}),
        repeatedMeasures: trials > 1,
        resamplingUnit: sampling.samplingKind === 'independent' ? 'sample' : 'paired-block',
        estimatorId,
        seedCoupling: sampling.samplingKind === 'independent'
          ? 'independent-by-target'
          : sampling.seedCoupling ?? 'shared-within-block',
      },
      scheduling: input.experiment.scheduling ?? {
        schedulingKind: sampling.samplingKind === 'solo' ? 'sequential' : 'interleaved',
      },
      randomizationSlots,
    },
    analysisGraph: {
      analysisMode: 'preregistered',
      nodes: analysisNodes.sort((left, right) => compareStrings(left.nodeId, right.nodeId)),
    },
    comparisons: comparisons.map((comparison) => ({
      comparisonId: comparison.comparisonId,
      controlTargetId: comparison.controlVariantId,
      treatmentTargetIds: [...comparison.treatmentVariantIds].sort(compareStrings),
      metricIds: [
        ...new Set([
          ...comparison.metricIds,
          ...(derivedComparisonMetricIds.get(comparison.comparisonId) ?? []),
        ]),
      ].sort(compareStrings),
    })),
    ...(decisionPolicy === undefined ? {} : { decisionPolicy }),
  });
  return deepFreezeCanonicalJson(definition);
}
