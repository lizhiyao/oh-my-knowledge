import type { AnalysisNodeCapabilities } from '../types.js';
import { canonicalizeJson, bonferroniMarginalAlpha, bonferroniMarginalConfidenceLevel, type AnalysisNodeDefinition, type EvaluationDefinition, type MetricDefinition } from '../../contracts/index.js';
import { definitionError } from '../errors.js';
import { assertUnique, assertReference } from './shared.js';

export function validateGraph(
  nodes: readonly AnalysisNodeDefinition[],
  metricIds: ReadonlySet<string>,
  comparisons: ReadonlyMap<string, EvaluationDefinition['comparisons'][number]>,
): void {
  const resultProducer = new Map<string, string>();
  for (const node of nodes) resultProducer.set(node.outputResultId, node.nodeId);
  const dependencies = new Map<string, Set<string>>();
  for (const node of nodes) {
    assertUnique(
      node.inputs.map((input) => canonicalizeJson(input)),
      `analysis-node:${node.nodeId}:input`,
    );
    const nodeDependencies = new Set<string>();
    for (const input of node.inputs) {
      if (input.inputKind === 'metric-observations') {
        assertReference(
          metricIds,
          input.referenceId,
          `analysisGraph.nodes.${node.nodeId}.inputs`,
          'Metric',
        );
      } else if (input.inputKind === 'analysis-result') {
        const producer = resultProducer.get(input.referenceId);
        if (producer === undefined) {
          throw definitionError(
            'EVAL_DEFINITION_MISSING_REFERENCE',
            'Analysis input 引用了不存在的 AnalysisResult。',
            {
              location: `analysisGraph.nodes.${node.nodeId}.inputs`,
              referenceKind: 'AnalysisResult',
              referenceId: input.referenceId,
            },
          );
        }
        nodeDependencies.add(producer);
      } else {
        assertReference(
          new Set(comparisons.keys()),
          input.referenceId,
          `analysisGraph.nodes.${node.nodeId}.inputs`,
          'Comparison',
        );
        const comparison = comparisons.get(input.referenceId);
        if (comparison !== undefined
            && (!comparison.treatmentTargetIds.includes(input.treatmentTargetId)
              || !comparison.metricIds.includes(input.metricId))) {
          throw definitionError(
            'EVAL_DEFINITION_MISSING_REFERENCE',
            'Analysis input 引用了不存在的 Comparison contrast。',
            { nodeId: node.nodeId, referenceId: input.referenceId },
          );
        }
      }
    }
    dependencies.set(node.nodeId, nodeDependencies);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      throw definitionError(
        'EVAL_DEFINITION_GRAPH_CYCLE',
        'AnalysisGraph 必须是无环图。',
        { nodeId },
      );
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const dependency of dependencies.get(nodeId) ?? []) visit(dependency);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of nodes) visit(node.nodeId);
}

export function validateSimultaneousIntervalFamilies(
  definition: EvaluationDefinition,
  parametersMaterialized: boolean,
): void {
  const nodeByResultId = new Map(definition.analysisGraph.nodes.map(
    (node) => [node.outputResultId, node],
  ));
  for (const node of definition.analysisGraph.nodes) {
    if (node.implementationId !== 'simultaneous-intervals.bonferroni/v1') continue;
    const memberResultIds = node.inputs.flatMap((input) => (
      input.inputKind === 'analysis-result' ? [input.referenceId] : []
    ));
    if (node.analysisNodeKind !== 'correction'
        || memberResultIds.length !== node.inputs.length
        || memberResultIds.length < 2
        || new Set(memberResultIds).size !== memberResultIds.length
        || canonicalizeJson(memberResultIds) !== canonicalizeJson([...memberResultIds].sort())) {
      throw definitionError(
        'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        'Bonferroni simultaneous interval family 必须按 canonical 顺序绑定至少两个唯一 AnalysisResult。',
        { nodeId: node.nodeId },
      );
    }
    const parameters = node.parameters;
    if (parameters === undefined || parameters === null || Array.isArray(parameters)
        || typeof parameters !== 'object') {
      if (!parametersMaterialized) continue;
      throw definitionError(
        'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        'Bonferroni simultaneous interval family 缺少已物化参数。',
        { nodeId: node.nodeId },
      );
    }
    const familyConfidenceLevel = (parameters as Record<string, unknown>).familyConfidenceLevel;
    const resamples = (parameters as Record<string, unknown>).resamples;
    if (typeof familyConfidenceLevel !== 'number'
        || typeof resamples !== 'number'
        || !Number.isFinite(familyConfidenceLevel)
        || !Number.isSafeInteger(resamples)) {
      if (!parametersMaterialized) continue;
      throw definitionError(
        'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        'Bonferroni simultaneous interval family 参数未完整物化。',
        { nodeId: node.nodeId },
      );
    }
    let expectedAlpha: number;
    try {
      expectedAlpha = bonferroniMarginalAlpha(
        familyConfidenceLevel,
        memberResultIds.length,
      );
      bonferroniMarginalConfidenceLevel(familyConfidenceLevel, memberResultIds.length);
    } catch {
      throw definitionError(
        'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        'Bonferroni simultaneous interval family 无法表示有效的边际置信度。',
        { nodeId: node.nodeId },
      );
    }
    const contrastSelectors: string[] = [];
    for (const resultId of memberResultIds) {
      const parent = nodeByResultId.get(resultId);
      const comparisonInputs = parent?.inputs.filter((input) => input.inputKind === 'comparison')
        ?? [];
      const metricInputs = parent?.inputs.filter(
        (input) => input.inputKind === 'metric-observations',
      ) ?? [];
      if (parent?.analysisNodeKind !== 'estimator'
          || comparisonInputs.length !== 1
          || metricInputs.length !== 1
          || metricInputs[0].referenceId !== comparisonInputs[0].metricId) {
        throw definitionError(
          'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
          'Simultaneous interval member 必须精确绑定一个 comparison contrast 与对应 Metric。',
          { nodeId: node.nodeId, referenceId: resultId },
        );
      }
      contrastSelectors.push(canonicalizeJson([
        comparisonInputs[0].referenceId,
        comparisonInputs[0].treatmentTargetId,
        comparisonInputs[0].metricId,
      ]));
      const parentParameters = parent?.parameters;
      const parentObject = parentParameters !== undefined
        && parentParameters !== null
        && !Array.isArray(parentParameters)
        && typeof parentParameters === 'object'
        ? parentParameters as Record<string, unknown>
        : undefined;
      if (typeof parentObject?.alpha !== 'number'
          || typeof parentObject.resamples !== 'number') {
        if (!parametersMaterialized) continue;
        throw definitionError(
          'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
          'Simultaneous interval member 必须公开标准 alpha 与 resamples 参数。',
          { nodeId: node.nodeId, referenceId: resultId },
        );
      }
      if (parentObject.alpha !== expectedAlpha || parentObject.resamples !== resamples) {
        throw definitionError(
          'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
          'Simultaneous interval member 必须使用由封存 family level 与 size 推导的 alpha 和 resamples。',
          { nodeId: node.nodeId, referenceId: resultId },
        );
      }
    }
    if (new Set(contrastSelectors).size !== contrastSelectors.length) {
      throw definitionError(
        'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        'Bonferroni simultaneous interval family 不能重复声明同一个 contrast。',
        { nodeId: node.nodeId },
      );
    }
  }
}

const COMPOSITE_ANALYSIS_IMPLEMENTATION_IDS = new Set([
  'bootstrap.composite-mean-percentile/v2',
  'bootstrap.composite-cluster-percentile/v2',
  'bootstrap.composite-paired-difference-percentile/v2',
  'bootstrap.composite-unpaired-difference-percentile/v2',
]);

export function isCompositeAnalysisImplementationId(implementationId: string): boolean {
  return COMPOSITE_ANALYSIS_IMPLEMENTATION_IDS.has(implementationId);
}

function validateCompositeAnalysisSemantics(definition: EvaluationDefinition): void {
  const metricsById = new Map(definition.metrics.map((metric) => [metric.metricId, metric]));
  for (const node of definition.analysisGraph.nodes) {
    if (!isCompositeAnalysisImplementationId(node.implementationId)) continue;
    const parameters = node.parameters;
    if (parameters === undefined || parameters === null || Array.isArray(parameters)
        || typeof parameters !== 'object') {
      throw definitionError(
        'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        'Composite Analysis 缺少已物化参数。',
        { nodeId: node.nodeId },
      );
    }
    const parameterObject = parameters as Record<string, unknown>;
    const compositeMetricId = parameterObject.compositeMetricId;
    const components = parameterObject.components;
    if (typeof compositeMetricId !== 'string' || !Array.isArray(components)) {
      throw definitionError(
        'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        'Composite Analysis 参数未完整物化。',
        { nodeId: node.nodeId },
      );
    }
    const componentMetricIds = components.flatMap((component) => (
      component !== null && !Array.isArray(component) && typeof component === 'object'
        && typeof (component as Record<string, unknown>).metricId === 'string'
        ? [(component as Record<string, unknown>).metricId as string]
        : []
    ));
    const metricInputs = node.inputs.filter(
      (input) => input.inputKind === 'metric-observations',
    );
    const inputMetricIds = metricInputs.map((input) => input.referenceId);
    const comparisonInputs = node.inputs.filter((input) => input.inputKind === 'comparison');
    const expectsComparison = node.implementationId.includes('-difference-');
    const selectedTargetIds = node.targetFilter?.includeTargetIds ?? [];
    if (expectsComparison ? node.targetFilter !== undefined : selectedTargetIds.length !== 1) {
      throw definitionError(
        'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        expectsComparison
          ? 'Composite difference 由 contrast 封存 Variant，不接受额外 target filter。'
          : 'Composite quality 必须通过 target filter 精确封存一个 Variant。',
        { nodeId: node.nodeId },
      );
    }
    if (node.analysisNodeKind !== 'estimator'
        || componentMetricIds.length !== components.length
        || componentMetricIds.length < 2
        || canonicalizeJson(componentMetricIds) !== canonicalizeJson([...componentMetricIds].sort())
        || canonicalizeJson(inputMetricIds) !== canonicalizeJson(componentMetricIds)
        || node.inputs.some((input) => input.inputKind === 'analysis-result')
        || comparisonInputs.length !== (expectsComparison ? 1 : 0)
        || (expectsComparison && comparisonInputs[0].metricId !== compositeMetricId)) {
      throw definitionError(
        'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        'Composite Analysis 必须按 canonical component 顺序精确绑定 source Metrics 与所需 contrast。',
        { nodeId: node.nodeId },
      );
    }
    const compositeMetric = metricsById.get(compositeMetricId);
    if (compositeMetric === undefined
        || compositeMetric.valueType !== 'numeric'
        || compositeMetric.scope !== 'sample'
        || compositeMetric.scale?.min !== 0
        || compositeMetric.scale.max !== 1
        || compositeMetric.scale.target !== undefined
        || compositeMetric.direction !== 'higher-is-better'
        || compositeMetric.missingPolicyId !== 'exclude/v1'
        || compositeMetric.unit !== 'utility'
        || definition.evaluators.some((evaluator) => (
          evaluator.metricIds.includes(compositeMetricId)
        ))) {
      throw definitionError(
        'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        'Composite derived Metric 必须是无 Evaluator 产出的 [0, 1] higher-is-better sample utility。',
        { nodeId: node.nodeId, metricId: compositeMetricId },
      );
    }
    for (const [componentIndex, componentMetricId] of componentMetricIds.entries()) {
      const metric = metricsById.get(componentMetricId);
      const supportedDirection = metric?.direction === 'higher-is-better'
        || metric?.direction === 'lower-is-better';
      const supportedNumeric = metric?.valueType === 'numeric'
        && typeof metric.scale?.min === 'number'
        && Number.isFinite(metric.scale.min)
        && typeof metric.scale.max === 'number'
        && Number.isFinite(metric.scale.max)
        && metric.scale.min < metric.scale.max;
      if (metric === undefined || metric.scope !== 'sample'
          || metric.missingPolicyId !== 'exclude/v1' || !supportedDirection
          || (metric.valueType !== 'boolean' && !supportedNumeric)) {
        throw definitionError(
          'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
          'Composite component 只接受具备 sealed monotonic utility 的 sample Metric。',
          { nodeId: node.nodeId, metricId: componentMetricId },
        );
      }
      const producingEvaluators = definition.evaluators.filter((evaluator) => (
        evaluator.metricIds.includes(componentMetricId)
      ));
      const component = components[componentIndex] as Record<string, unknown>;
      const aggregation = component.measurementAggregation;
      const aggregateEvaluatorIds = aggregation !== undefined && aggregation !== null
          && !Array.isArray(aggregation) && typeof aggregation === 'object'
        ? ((aggregation as Record<string, unknown>).members as unknown[] | undefined)?.flatMap(
          (member) => member !== null && !Array.isArray(member) && typeof member === 'object'
            ? (((member as Record<string, unknown>).replicates as unknown[] | undefined) ?? [])
              .flatMap((replicate) => replicate !== null && !Array.isArray(replicate)
                && typeof replicate === 'object'
                && typeof (replicate as Record<string, unknown>).evaluatorId === 'string'
                ? [(replicate as Record<string, unknown>).evaluatorId as string]
                : [])
            : [],
        ) ?? []
        : [];
      const producingEvaluatorIds = producingEvaluators.map(
        (evaluator) => evaluator.evaluatorId,
      ).sort();
      if (producingEvaluatorIds.length === 0
          || (aggregation === undefined && producingEvaluatorIds.length !== 1)
          || (aggregation !== undefined && canonicalizeJson([...aggregateEvaluatorIds].sort())
            !== canonicalizeJson(producingEvaluatorIds))) {
        throw definitionError(
          'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
          'Composite component 的 measurement aggregation 必须精确覆盖全部 source Evaluator。',
          { nodeId: node.nodeId, metricId: componentMetricId },
        );
      }
    }
  }
}

export function validateMaterializedAnalysisSemantics(
  definition: EvaluationDefinition,
): void {
  validateSimultaneousIntervalFamilies(definition, true);
  validateCompositeAnalysisSemantics(definition);
}

export function validateMaterializedDecisionSemantics(
  definition: EvaluationDefinition,
): void {
  const policy = definition.decisionPolicy;
  if (policy?.implementationId !== 'release-family/v1') return;
  const family = policy.comparisonFamily ?? [];
  const familyResultId = policy.comparisonFamilyResultId;
  const parameters = policy.parameters;
  const criteria = parameters !== undefined && parameters !== null
      && !Array.isArray(parameters) && typeof parameters === 'object'
    ? (parameters as Record<string, unknown>).criteria
    : undefined;
  const criterionIds = (Array.isArray(criteria) ? criteria.flatMap((criterion) => (
    criterion !== null && !Array.isArray(criterion) && typeof criterion === 'object'
      && typeof (criterion as Record<string, unknown>).analysisResultId === 'string'
      ? [(criterion as Record<string, unknown>).analysisResultId as string]
      : []
  )) : []).sort();
  const memberIds = family.map((member) => member.analysisResultId).sort();
  if (familyResultId === undefined
      || policy.analysisResultIds.length !== 1
      || policy.analysisResultIds[0] !== familyResultId
      || policy.multipleComparisonPolicyId !== 'simultaneous-intervals.bonferroni/v1'
      || family.length < 2
      || family.some((member) => member.analysisResultId === familyResultId)
      || family.some((member) => 'hypothesisId' in member)
      || canonicalizeJson(criterionIds) !== canonicalizeJson(memberIds)) {
    throw definitionError(
      'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
      'release-family/v1 必须精确绑定一份权威 simultaneous family 与全部 member criterion。',
      { referenceId: policy.decisionPolicyId },
    );
  }
}

export function validateAnalysisInputs(
  node: AnalysisNodeDefinition,
  capabilities: AnalysisNodeCapabilities,
  metricsById: ReadonlyMap<string, MetricDefinition>,
  outputSchemasByResultId: ReadonlyMap<string, string>,
): void {
  const cardinalities = [
    ['metric-observations', capabilities.inputCardinalities.metricObservations],
    ['analysis-result', capabilities.inputCardinalities.analysisResults],
    ['comparison', capabilities.inputCardinalities.comparisons],
  ] as const;
  for (const [inputKind, cardinality] of cardinalities) {
    const inputCount = node.inputs.filter((input) => input.inputKind === inputKind).length;
    if (inputCount < cardinality.min
        || (cardinality.max !== undefined && inputCount > cardinality.max)) {
      throw definitionError(
        'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
        'Analysis Runtime 不支持声明的输入数量。',
        { nodeId: node.nodeId, inputKind, inputCount },
      );
    }
  }
  for (const input of node.inputs) {
    if (input.inputKind === 'metric-observations') {
      const metric = metricsById.get(input.referenceId);
      const compatible = capabilities.inputDomains.some((domain) => (
        domain.inputKind === 'metric-observations'
        && metric !== undefined
        && domain.valueTypes.includes(metric.valueType)
        && (domain.missingPolicyIds === undefined
          || domain.missingPolicyIds.includes(metric.missingPolicyId))
      ));
      if (compatible) continue;
    } else {
      if (input.inputKind === 'comparison') {
        const compatible = capabilities.inputDomains.some(
          (domain) => domain.inputKind === 'comparison',
        );
        if (compatible) continue;
      }
      const schemaUri = outputSchemasByResultId.get(input.referenceId);
      const compatible = capabilities.inputDomains.some((domain) => (
        domain.inputKind === 'analysis-result'
        && schemaUri !== undefined
        && domain.schemaUris.includes(schemaUri)
      ));
      if (compatible) continue;
    }
    throw definitionError(
      'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
      'Analysis implementation 不接受声明的输入值域。',
      { nodeId: node.nodeId, inputKind: input.inputKind, referenceId: input.referenceId },
    );
  }
}
