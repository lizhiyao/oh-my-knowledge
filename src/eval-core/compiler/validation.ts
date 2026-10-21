import { canonicalizeJson, type EvaluationDefinition, type MeasurementPolicy } from '../contracts/index.js';
import { analysisComparisonAppliesToMetricInput } from '../contracts/analysis-input-matching.js';
import { definitionError } from './errors.js';
import { assertUnique, assertReference } from './validation/shared.js';
import { validateSamplingDesign } from './validation/sampling.js';
import { validateEvaluatorBindings, validateTargetExecutionControls, validateMetric } from './validation/bindings.js';
import { validatePolicy } from './validation/policy.js';
import { validateGraph, validateSimultaneousIntervalFamilies } from './validation/analysis.js';
export { isCompositeAnalysisImplementationId, validateMaterializedAnalysisSemantics, validateMaterializedDecisionSemantics, validateAnalysisInputs } from './validation/analysis.js';

export function validateDefinitionSemantics(
  definition: EvaluationDefinition,
  policy: MeasurementPolicy,
): void {
  assertUnique(definition.dataset.samples.map((sample) => sample.sampleId), 'sample');
  const cohorts = definition.dataset.analysisCohorts ?? [];
  assertUnique(cohorts.map((cohort) => cohort.cohortId), 'analysis-cohort');
  assertUnique(definition.targets.map((target) => target.targetId), 'target');
  assertUnique(definition.evaluators.map((evaluator) => evaluator.evaluatorId), 'evaluator');
  assertUnique(definition.metrics.map((metric) => metric.metricId), 'metric');
  assertUnique(definition.analysisGraph.nodes.map((node) => node.nodeId), 'analysis-node');
  assertUnique(
    definition.analysisGraph.nodes.map((node) => node.outputResultId),
    'analysis-result',
  );
  assertUnique(definition.comparisons.map((comparison) => comparison.comparisonId), 'comparison');
  validateTargetExecutionControls(definition);

  const targetIds = new Set(definition.targets.map((target) => target.targetId));
  const metricIds = new Set(definition.metrics.map((metric) => metric.metricId));
  const metricsById = new Map(definition.metrics.map((metric) => [metric.metricId, metric]));
  const resultIds = new Set(
    definition.analysisGraph.nodes.map((node) => node.outputResultId),
  );
  const cohortIds = new Set(cohorts.map((cohort) => cohort.cohortId));
  const cohortById = new Map(cohorts.map((cohort) => [cohort.cohortId, cohort]));
  const cohortSetKinds = new Map<string, string>();
  const partitionDerivations = new Map<string, string>();
  for (const cohort of cohorts) {
    const existingKind = cohortSetKinds.get(cohort.cohortSetId);
    if (existingKind !== undefined && existingKind !== cohort.cohortSetKind) {
      throw definitionError(
        'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        '同一 Analysis cohort set 必须使用一致的集合语义。',
        { cohortSetId: cohort.cohortSetId },
      );
    }
    cohortSetKinds.set(cohort.cohortSetId, cohort.cohortSetKind);
    if (cohort.cohortSetKind === 'partition') {
      const derivation = canonicalizeJson(cohort.derivation ?? null);
      const existingDerivation = partitionDerivations.get(cohort.cohortSetId);
      if (existingDerivation !== undefined && existingDerivation !== derivation) {
        throw definitionError(
          'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
          '同一 Analysis partition 必须使用一致的 membership derivation。',
          { cohortSetId: cohort.cohortSetId },
        );
      }
      partitionDerivations.set(cohort.cohortSetId, derivation);
    }
  }

  for (const sample of definition.dataset.samples) {
    const memberships = sample.analysis?.memberships ?? [];
    assertUnique(memberships.map((membership) => membership.cohortId), `sample:${sample.sampleId}:cohort`);
    const cohortSets = new Set<string>();
    for (const membership of memberships) {
      assertReference(
        cohortIds,
        membership.cohortId,
        `dataset.samples.${sample.sampleId}.analysis.memberships`,
        'AnalysisCohort',
      );
      const cohort = cohortById.get(membership.cohortId);
      if (cohort?.cohortSetKind === 'partition') {
        if (cohortSets.has(cohort.cohortSetId)) {
          throw definitionError(
            'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
            '同一 Sample 在一个 partition 中只能属于一个 cohort。',
            { sampleId: sample.sampleId, cohortSetId: cohort.cohortSetId },
          );
        }
        cohortSets.add(cohort.cohortSetId);
      }
      if (membership.membershipValue !== undefined && cohort?.disclosure !== 'full') {
        throw definitionError(
          'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
          'identity-only cohort 不能携带 raw membership value。',
          { sampleId: sample.sampleId, cohortId: membership.cohortId },
        );
      }
    }
  }

  for (const node of definition.analysisGraph.nodes) {
    const includeTargets = node.targetFilter?.includeTargetIds ?? [];
    assertUnique(includeTargets, `analysis-node:${node.nodeId}:include-target`);
    for (const targetId of includeTargets) {
      assertReference(
        targetIds,
        targetId,
        `analysisGraph.nodes.${node.nodeId}.targetFilter`,
        'Target',
      );
    }
    const include = node.cohortFilter?.includeCohortIds ?? [];
    const exclude = node.cohortFilter?.excludeCohortIds ?? [];
    if (node.cohortFilter !== undefined && include.length === 0 && exclude.length === 0) {
      throw definitionError(
        'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        `Analysis 节点“${node.nodeId}”声明了空 cohort filter。`,
        { nodeId: node.nodeId },
      );
    }
    assertUnique(include, `analysis-node:${node.nodeId}:include-cohort`);
    assertUnique(exclude, `analysis-node:${node.nodeId}:exclude-cohort`);
    for (const cohortId of [...include, ...exclude]) {
      assertReference(
        cohortIds,
        cohortId,
        `analysisGraph.nodes.${node.nodeId}.cohortFilter`,
        'AnalysisCohort',
      );
    }
    if (include.some((cohortId) => exclude.includes(cohortId))) {
      throw definitionError(
        'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
        'Analysis cohort filter 不能同时包含并排除同一个 cohort。',
        { nodeId: node.nodeId },
      );
    }
  }

  for (const evaluator of definition.evaluators) {
    assertUnique(evaluator.metricIds, `evaluator:${evaluator.evaluatorId}:metric`);
    for (const metricId of evaluator.metricIds) {
      assertReference(
        metricIds,
        metricId,
        `evaluators.${evaluator.evaluatorId}.metricIds`,
        'Metric',
      );
      if (metricsById.get(metricId)?.scope !== 'sample') {
        throw definitionError(
          'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
          'v1 record-scoped Evaluator 只能直接产生 sample scope Metric。',
          { evaluatorId: evaluator.evaluatorId, metricId },
        );
      }
    }
  }
  // Disjoint sample scopes may share an instrument/member/replicate coordinate.
  // Only coordinates that can produce two readings on the same sample conflict.
  const measurementCoordinates = definition.evaluators.flatMap((evaluator) => (
    evaluator.applicableSampleIds ?? definition.dataset.samples.map((sample) => sample.sampleId)
  ).map((sampleId) => canonicalizeJson({
    sampleId,
    instrumentId: evaluator.measurement.instrumentId,
    ensembleMemberId: evaluator.measurement.ensembleMemberId,
    replicateGroupId: evaluator.measurement.replicateGroupId,
    replicateIndex: evaluator.measurement.replicateIndex,
  })));
  assertUnique(measurementCoordinates, 'evaluator-measurement-coordinate');
  for (const comparison of definition.comparisons) {
    assertReference(
      targetIds,
      comparison.controlTargetId,
      `comparisons.${comparison.comparisonId}.controlTargetId`,
      'Target',
    );
    assertUnique(
      comparison.treatmentTargetIds,
      `comparison:${comparison.comparisonId}:treatment-target`,
    );
    for (const targetId of comparison.treatmentTargetIds) {
      assertReference(
        targetIds,
        targetId,
        `comparisons.${comparison.comparisonId}.treatmentTargetIds`,
        'Target',
      );
      if (targetId === comparison.controlTargetId) {
        throw definitionError(
          'EVAL_DEFINITION_VALUE_DOMAIN_INVALID',
          'Comparison 的 control 与 treatment 必须是不同 Target。',
          { comparisonId: comparison.comparisonId, targetId },
        );
      }
    }
    assertUnique(comparison.metricIds, `comparison:${comparison.comparisonId}:metric`);
    for (const metricId of comparison.metricIds) {
      assertReference(
        metricIds,
        metricId,
        `comparisons.${comparison.comparisonId}.metricIds`,
        'Metric',
      );
    }
  }
  validateSimultaneousIntervalFamilies(definition, false);
  if (definition.decisionPolicy !== undefined) {
    assertUnique(definition.decisionPolicy.analysisResultIds, 'decision-policy:analysis-result');
    for (const resultId of definition.decisionPolicy.analysisResultIds) {
      assertReference(
        resultIds,
        resultId,
        'decisionPolicy.analysisResultIds',
        'AnalysisResult',
      );
    }
    const family = definition.decisionPolicy.comparisonFamily ?? [];
    const hypothesisMembers = family.filter(
      (member): member is typeof member & { hypothesisId: string } => (
        'hypothesisId' in member
      ),
    );
    assertUnique(hypothesisMembers.map((member) => member.hypothesisId), 'decision-policy:hypothesis');
    const familyResultId = definition.decisionPolicy.comparisonFamilyResultId;
    const sharesFamilyResult = familyResultId !== undefined
      && family.length > 0
      && family.every((member) => member.analysisResultId === familyResultId);
    const usesDistinctMemberResults = familyResultId !== undefined
      && family.length > 0
      && family.every((member) => member.analysisResultId !== familyResultId);
    if (familyResultId === undefined || usesDistinctMemberResults) {
      assertUnique(
        family.map((member) => member.analysisResultId),
        'decision-policy:family-analysis-result',
      );
    }
    if (familyResultId !== undefined && (family.length === 0
        || !definition.decisionPolicy.analysisResultIds.includes(familyResultId)
        || (!sharesFamilyResult && !usesDistinctMemberResults)
        || (usesDistinctMemberResults && family.length < 2)
        || hypothesisMembers.length > 0)) {
      throw definitionError(
        'EVAL_DEFINITION_MISSING_REFERENCE',
        '权威 comparison family result 必须采用完整的 shared-result 或 distinct-member 形态，且不能伪装成 raw-hypothesis family。',
        { referenceId: familyResultId },
      );
    }
    assertUnique(
      family.map((member) => canonicalizeJson([
        member.comparisonId,
        member.treatmentTargetId,
        member.metricId,
      ])),
      'decision-policy:comparison-family-member',
    );
    const comparisonById = new Map(definition.comparisons.map(
      (comparison) => [comparison.comparisonId, comparison],
    ));
    const nodeByResultId = new Map(definition.analysisGraph.nodes.map(
      (node) => [node.outputResultId, node],
    ));
    for (const member of family) {
      const comparison = comparisonById.get(member.comparisonId);
      if (comparison === undefined
          || !comparison.treatmentTargetIds.includes(member.treatmentTargetId)
          || !comparison.metricIds.includes(member.metricId)) {
        throw definitionError(
          'EVAL_DEFINITION_MISSING_REFERENCE',
          'DecisionPolicy comparison family 引用了不存在的 contrast。',
          { comparisonId: member.comparisonId },
        );
      }
      const producer = nodeByResultId.get(member.analysisResultId);
      const producerMetricInputs = producer?.inputs.filter(
        (input) => input.inputKind === 'metric-observations',
      ) ?? [];
      const producerComparisonInputs = producer?.inputs.filter(
        (input) => input.inputKind === 'comparison',
      ) ?? [];
      const expectedComparisonInput = canonicalizeJson({
        inputKind: 'comparison',
        referenceId: member.comparisonId,
        treatmentTargetId: member.treatmentTargetId,
        metricId: member.metricId,
      });
      const consumesOnlySelectedContrast = producer !== undefined
        && producer.inputs.length === producerMetricInputs.length + 1
        && producerMetricInputs.length > 0
        && producerMetricInputs.every((input) => analysisComparisonAppliesToMetricInput(
          producer,
          member.metricId,
          input.referenceId,
        ))
        && producerComparisonInputs.length === 1
        && canonicalizeJson(producerComparisonInputs[0]) === expectedComparisonInput;
      if (producer === undefined
          || (!sharesFamilyResult
            && !consumesOnlySelectedContrast)) {
        throw definitionError(
          'EVAL_DEFINITION_MISSING_REFERENCE',
          'Comparison family member 必须精确绑定只消费该 contrast 的 AnalysisResult。',
          { referenceId: member.analysisResultId },
        );
      }
    }
    const correctionId = definition.decisionPolicy.multipleComparisonPolicyId;
    if ((family.length > 1) !== (correctionId !== undefined)) {
      throw definitionError(
        'EVAL_DEFINITION_MISSING_REFERENCE',
        '多个 comparison family member 必须声明 correction，单个或空 family 不得伪装成多重比较。',
      );
    }
    if (correctionId !== undefined && familyResultId === undefined) {
      const correctionNodes = definition.analysisGraph.nodes.filter((node) => (
        node.analysisNodeKind === 'correction'
        && node.implementationId === correctionId
      ));
      if (correctionNodes.length !== 1
          || !definition.decisionPolicy.analysisResultIds.includes(
            correctionNodes[0].outputResultId,
          )) {
        throw definitionError(
          'EVAL_DEFINITION_MISSING_REFERENCE',
          'DecisionPolicy 的 multiple-comparison policy 必须绑定唯一 correction result。',
          { referenceId: correctionId },
        );
      }
      if (hypothesisMembers.length !== family.length) {
        throw definitionError(
          'EVAL_DEFINITION_MISSING_REFERENCE',
          '多重比较 family 的每个 member 都必须绑定原始 hypothesis result。',
        );
      }
      const correctionInputs = correctionNodes[0].inputs;
      const correctionResultIds = correctionInputs
        .filter((input) => input.inputKind === 'analysis-result')
        .map((input) => input.referenceId)
        .sort();
      const expectedResultIds = hypothesisMembers.map(
        (member) => member.analysisResultId,
      ).sort();
      if (correctionInputs.some((input) => input.inputKind !== 'analysis-result')
          || canonicalizeJson(correctionResultIds) !== canonicalizeJson(expectedResultIds)) {
        throw definitionError(
          'EVAL_DEFINITION_MISSING_REFERENCE',
          'Correction node inputs 必须精确等于 comparison family 的原始 hypothesis results。',
          { referenceId: correctionId },
        );
      }
    } else if (correctionId !== undefined && usesDistinctMemberResults) {
      const familyProducer = nodeByResultId.get(familyResultId as string);
      const familyInputs = familyProducer?.inputs.flatMap((input) => (
        input.inputKind === 'analysis-result' ? [input.referenceId] : []
      )).sort() ?? [];
      const memberResultIds = family.map((member) => member.analysisResultId).sort();
      if ((familyProducer?.analysisNodeKind !== 'estimator'
          && familyProducer?.analysisNodeKind !== 'correction')
          || (familyProducer.analysisNodeKind === 'correction'
            && correctionId === 'bonferroni/v1')
          || familyProducer.implementationId !== correctionId
          || familyInputs.length !== familyProducer.inputs.length
          || canonicalizeJson(familyInputs) !== canonicalizeJson(memberResultIds)) {
        throw definitionError(
          'EVAL_DEFINITION_MISSING_REFERENCE',
          '权威 comparison family result 必须由声明的 family standard 精确消费全部 member result 后产生。',
          { referenceId: correctionId },
        );
      }
    } else if (correctionId !== undefined) {
      const familyProducer = nodeByResultId.get(familyResultId as string);
      if (familyProducer?.analysisNodeKind !== 'estimator'
          || familyProducer.implementationId !== correctionId) {
        throw definitionError(
          'EVAL_DEFINITION_MISSING_REFERENCE',
          'Shared-result comparison family 必须由声明的 estimator-owned standard 产生。',
          { referenceId: correctionId },
        );
      }
    } else if (correctionId === undefined) {
      for (const member of family) {
        if (!definition.decisionPolicy.analysisResultIds.includes(member.analysisResultId)) {
          throw definitionError(
            'EVAL_DEFINITION_MISSING_REFERENCE',
            '未校正的 comparison family member 必须直接绑定 DecisionPolicy 消费的 AnalysisResult。',
            { referenceId: member.analysisResultId },
          );
        }
      }
    }
  }
  for (const metric of definition.metrics) validateMetric(metric);
  validateEvaluatorBindings(definition);
  validateSamplingDesign(definition);
  validateGraph(
    definition.analysisGraph.nodes,
    metricIds,
    new Map(definition.comparisons.map((comparison) => [comparison.comparisonId, comparison])),
  );
  validatePolicy(definition, policy);
}
