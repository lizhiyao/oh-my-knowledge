import {
  type Judge,
  type Dataset,
  type ExactMatchEvaluator,
  type RetrievalEvaluator,
  type ToolTrajectoryEvaluator,
  type Evaluator,
  type RubricJudgeMember,
} from './contracts.js';
import {
  configurationFailure,
  EvaluationConfigurationError,
} from './errors.js';
import {
  deepFreezeCanonicalJson,
  type EvaluatorDefinition,
  type MetricDefinition,
  IdentifierSchema,
  digestCanonicalJson,
  EvaluatorDefinitionSchema,
  MetricDefinitionSchema,
  type JsonValue,
} from '../../eval-core/contracts/index.js';
import {
  createRuntimeIdentity,
} from '../identity.js';
import {
  type OmkLlmJudgeInvocationRequest,
  type OmkLlmJudgeInvocationResult,
} from '../judges/invocation.js';
import {
  type RuntimePortRegistration,
} from '../runtime.js';
import {
  type EvaluationEvaluator,
} from '../../eval-core/evaluation/index.js';
import {
  type EvaluatorRuntimeRequirement,
} from '../../eval-core/compiler/index.js';
import {
  EXACT_MATCH_EVALUATOR_IMPLEMENTATION_ID,
  createExactMatchEvaluator,
} from '../evaluators/exact-match.js';
import {
  RetrievalEvaluatorInputSchema,
  ToolTrajectoryEvaluatorInputSchema,
  MAX_RUBRIC_PANEL_COORDINATES,
} from './schemas.js';
import {
  RETRIEVAL_EVALUATOR_IMPLEMENTATION_ID,
  createRetrievalEvaluator,
} from '../evaluators/retrieval.js';
import {
  TOOL_TRAJECTORY_EVALUATOR_IMPLEMENTATION_ID,
  createToolTrajectoryEvaluator,
} from '../evaluators/tool-trajectory.js';
import {
  SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
} from '../traces/source-neutral.js';
import {
  type RubricJudgeKit,
  createRubricJudgeKit,
  createRubricJudgeEvaluationContext,
  createRubricJudgeRegistration,
} from '../judges/rubric-kit.js';
import {
  type RubricJudgeCriterion,
} from '../judges/rubric-contracts.js';
import {
  createAbstentionEvaluatorBinding,
  ABSTENTION_EVALUATOR_IMPLEMENTATION_ID,
} from '../evaluators/abstention.js';
import {
  captureCustomEvaluator,
} from '../custom-evaluator.js';
import {
  compareStrings,
} from './ordering.js';
import {
  captureDataset,
} from './capture-input.js';

function captureJudge(value: Readonly<Judge>) {
  if (typeof value?.invoke !== 'function') {
    return configurationFailure(
      'EVAL_RUNTIME_EVALUATOR_INVALID',
      'Rubric 评委声明无效。',
    );
  }
  const invoke = value.invoke;
  try {
    const providerCost = deepFreezeCanonicalJson(structuredClone(value.providerCost));
    const fingerprintFacets = value.fingerprintFacets === undefined
      ? undefined
      : deepFreezeCanonicalJson(structuredClone(value.fingerprintFacets));
    const identity = createRuntimeIdentity({
      implementationId: value.judgeId,
      version: value.version,
      capabilities: {
        invocationKind: 'llm-judge',
        cancellation: 'cooperative',
        providerCost,
      },
      fingerprintFacets: {
        facade: 'omk.eval-runtime.rubric-judge/v1',
        ...(fingerprintFacets === undefined
          ? {}
          : { host: fingerprintFacets }),
      },
    });
    const receiver: Judge = Object.freeze({
      judgeId: identity.implementationId,
      version: value.version,
      providerCost,
      ...(fingerprintFacets === undefined ? {} : { fingerprintFacets }),
      invoke,
    });
    return Object.freeze({
      identity,
      providerCost: receiver.providerCost,
      invoke: (request: Readonly<OmkLlmJudgeInvocationRequest>) => Reflect.apply(
        invoke,
        receiver,
        [request],
      ) as Promise<OmkLlmJudgeInvocationResult>,
    });
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_EVALUATOR_INVALID',
      'Rubric 评委身份或费用声明无效。',
    );
  }
}

export interface CapturedEvaluators {
  readonly dataset: Dataset;
  readonly definitions: readonly EvaluatorDefinition[];
  readonly metrics: readonly MetricDefinition[];
  readonly measurementAggregations: ReadonlyMap<string, MeasurementAggregationPlan>;
  readonly registrations: readonly RuntimePortRegistration<
    EvaluationEvaluator,
    EvaluatorRuntimeRequirement
  >[];
}

interface MeasurementAggregationPlan {
  readonly method: 'mean' | 'weighted-mean';
  readonly missing: 'require-complete';
  readonly replicateGroupId: string;
  readonly members: readonly Readonly<{
    ensembleMemberId: string;
    weight?: number;
    replicates: readonly Readonly<{
      evaluatorId: string;
      instrumentId: string;
      replicateIndex: number;
    }>[];
  }>[];
}

function panelEvaluatorId(panelId: string, memberId: string, replicateIndex: number): string {
  const readable = `${panelId}/${memberId}/replicate-${replicateIndex}`;
  return IdentifierSchema.safeParse(readable).success
    ? readable
    : `rubric-panel:${digestCanonicalJson({
        derivation: 'omk.eval-runtime.rubric-panel-evaluator-id/v1',
        panelId,
        memberId,
        replicateIndex,
      }).slice('sha256:'.length)}`;
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function exactMatchDefinition(input: Readonly<ExactMatchEvaluator>): Readonly<{
  definition: EvaluatorDefinition;
  metric: MetricDefinition;
  port: EvaluationEvaluator;
}> {
  const metricId = IdentifierSchema.parse(input.metricId ?? 'correct');
  const readableDefaultId = `exact-match-${metricId}`;
  const defaultEvaluatorId = metricId === 'correct'
    ? 'exact-match'
    : IdentifierSchema.safeParse(readableDefaultId).success
      ? readableDefaultId
      : `exact-match:${digestCanonicalJson({
          derivation: 'omk.eval-runtime.exact-match-evaluator-id/v1',
          metricId,
        }).slice('sha256:'.length)}`;
  const evaluatorId = IdentifierSchema.parse(
    input.evaluatorId ?? defaultEvaluatorId,
  );
  const definition = EvaluatorDefinitionSchema.parse({
    evaluatorId,
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
  });
  const metric = MetricDefinitionSchema.parse({
    metricId,
    valueType: 'boolean',
    scope: 'sample',
    direction: 'higher-is-better',
    missingPolicyId: 'exclude/v1',
  });
  return Object.freeze({
    definition,
    metric,
    port: createExactMatchEvaluator({ metricId }),
  });
}

function retrievalDefinition(input: Readonly<RetrievalEvaluator>): Readonly<{
  definition: EvaluatorDefinition;
  metrics: readonly MetricDefinition[];
  port: EvaluationEvaluator;
}> {
  const parsed = RetrievalEvaluatorInputSchema.parse(structuredClone(input));
  const metricIds = [
    parsed.metricIds.recallAtK,
    parsed.metricIds.precisionAtK,
    parsed.metricIds.reciprocalRankAtK,
    parsed.metricIds.ndcgAtK,
  ];
  const portInput = {
    evaluatorId: parsed.evaluatorId,
    cutoff: parsed.cutoff,
    metricIds: parsed.metricIds,
    rankingSource: parsed.ranking.source,
    rankingPointer: parsed.ranking.pointer,
    relevantDocumentIdsPointer: parsed.relevantDocumentIdsPointer,
  };
  return Object.freeze({
    definition: EvaluatorDefinitionSchema.parse({
      evaluatorId: parsed.evaluatorId,
      evaluatorKind: 'assertion',
      implementationId: RETRIEVAL_EVALUATOR_IMPLEMENTATION_ID,
      measurement: {
        instrumentId: 'binary-top-k-retrieval-v1',
        ensembleMemberId: 'deterministic-local',
        replicateGroupId: 'deterministic-primary',
        replicateIndex: 0,
      },
      metricIds,
      inputs: [{
        bindingId: 'ranking',
        sourceKind: parsed.ranking.source,
        pointer: parsed.ranking.pointer,
      }, {
        bindingId: 'relevant-document-ids',
        sourceKind: 'expected',
        pointer: parsed.relevantDocumentIdsPointer,
      }],
      config: {
        cutoff: parsed.cutoff,
        relevance: 'binary',
        discount: 'log2',
        precisionDenominator: 'cutoff',
      },
    }),
    metrics: metricIds.map((metricId) => MetricDefinitionSchema.parse({
      metricId,
      valueType: 'numeric',
      scope: 'sample',
      scale: { min: 0, max: 1 },
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    })),
    port: createRetrievalEvaluator(portInput),
  });
}

function toolTrajectoryDefinition(input: Readonly<ToolTrajectoryEvaluator>): Readonly<{
  definition: EvaluatorDefinition;
  metric: MetricDefinition;
  port: EvaluationEvaluator;
}> {
  const parsed = ToolTrajectoryEvaluatorInputSchema.parse(structuredClone(input));
  const portInput = {
    evaluatorId: parsed.evaluatorId,
    metricId: parsed.metricId,
    tracePointer: parsed.tracePointer,
    expectedToolNamesPointer: parsed.expectedToolNamesPointer,
    match: parsed.match,
  };
  return Object.freeze({
    definition: EvaluatorDefinitionSchema.parse({
      evaluatorId: parsed.evaluatorId,
      evaluatorKind: 'assertion',
      implementationId: TOOL_TRAJECTORY_EVALUATOR_IMPLEMENTATION_ID,
      measurement: {
        instrumentId: 'source-neutral-tool-trajectory-v1',
        ensembleMemberId: 'deterministic-local',
        replicateGroupId: 'deterministic-primary',
        replicateIndex: 0,
      },
      metricIds: [parsed.metricId],
      inputs: [{
        bindingId: 'trace',
        sourceKind: 'trace',
        pointer: parsed.tracePointer,
      }, {
        bindingId: 'expected-tool-names',
        sourceKind: 'expected',
        pointer: parsed.expectedToolNamesPointer,
      }],
      config: {
        match: parsed.match,
        traceSchemaVersion: SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
        toolIdentityComparison: 'case-sensitive',
        toolCallCollection: 'top-level-toolCalls',
        toolCallOrder: 'array-order',
        toolCallSelection: 'all-statuses',
        traceRoleSelection: 'all',
        multiplicity: 'preserved',
      },
    }),
    metric: MetricDefinitionSchema.parse({
      metricId: parsed.metricId,
      valueType: 'boolean',
      scope: 'sample',
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    }),
    port: createToolTrajectoryEvaluator(portInput),
  });
}

export function captureEvaluators(
  dataset: Readonly<Dataset>,
  values: readonly Evaluator[],
): CapturedEvaluators {
  if (!Array.isArray(values) || values.length === 0) {
    return configurationFailure(
      'EVAL_RUNTIME_EVALUATOR_INVALID',
      'Evaluation 至少需要一个 evaluator。',
    );
  }
  const definitions: EvaluatorDefinition[] = [];
  const metrics: MetricDefinition[] = [];
  const measurementAggregations = new Map<string, MeasurementAggregationPlan>();
  const exactPorts = new Map<string, EvaluationEvaluator>();
  const retrievalPorts = new Map<string, EvaluationEvaluator>();
  const abstentionPorts = new Map<string, EvaluationEvaluator>();
  const toolTrajectoryPorts = new Map<string, EvaluationEvaluator>();
  const rubricEntries: Array<Readonly<{
    kit: Readonly<RubricJudgeKit>;
    criterion: Readonly<RubricJudgeCriterion>;
  }>> = [];
  const customEntries: Array<Readonly<{
    evaluatorId: string;
    implementationId: string;
    version: string;
    port: EvaluationEvaluator;
  }>> = [];
  try {
    for (const value of values) {
      if (value.evaluatorKind === 'exact-match') {
        const captured = exactMatchDefinition(value);
        definitions.push(captured.definition);
        metrics.push(captured.metric);
        exactPorts.set(captured.definition.evaluatorId, captured.port);
        continue;
      }
      if (value.evaluatorKind === 'retrieval') {
        let captured;
        try {
          captured = retrievalDefinition(value);
        } catch {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Retrieval Evaluator 配置无效。',
          );
        }
        definitions.push(captured.definition);
        metrics.push(...captured.metrics);
        retrievalPorts.set(captured.definition.evaluatorId, captured.port);
        continue;
      }
      if (value.evaluatorKind === 'abstention') {
        let captured;
        try {
          captured = createAbstentionEvaluatorBinding(value);
        } catch {
          return configurationFailure('EVAL_RUNTIME_EVALUATOR_INVALID', '弃答 Evaluator 配置无效。');
        }
        definitions.push(captured.definition);
        metrics.push(...captured.metrics);
        abstentionPorts.set(captured.definition.evaluatorId, captured.port);
        continue;
      }
      if (value.evaluatorKind === 'tool-trajectory') {
        let captured;
        try {
          captured = toolTrajectoryDefinition(value);
        } catch {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Tool Trajectory Evaluator 配置无效。',
          );
        }
        definitions.push(captured.definition);
        metrics.push(captured.metric);
        toolTrajectoryPorts.set(captured.definition.evaluatorId, captured.port);
        continue;
      }
      if (value.evaluatorKind === 'custom') {
        let captured;
        try {
          captured = captureCustomEvaluator(value);
        } catch {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Custom Evaluator 配置无效。',
          );
        }
        definitions.push(captured.definition);
        metrics.push(captured.metric);
        customEntries.push({
          evaluatorId: captured.definition.evaluatorId,
          implementationId: captured.implementationId,
          version: captured.version,
          port: captured.port,
        });
        continue;
      }
      if (value.evaluatorKind !== 'rubric-judge') {
        return configurationFailure(
          'EVAL_RUNTIME_EVALUATOR_INVALID',
          'Evaluation evaluatorKind 不受支持。',
        );
      }
      const panelId = IdentifierSchema.parse(value.evaluatorId);
      const metricId = IdentifierSchema.parse(value.metricId);
      if (!hasOnlyKeys(value, [
        'evaluatorKind', 'evaluatorId', 'metricId', 'judges', 'aggregation', 'rubric',
        'lengthDebias', 'tracePolicy', 'actualPointer', 'tracePointer', 'classification',
      ])
          || !Array.isArray(value.judges) || value.judges.length === 0
          || value.judges.length > MAX_RUBRIC_PANEL_COORDINATES
          || value.aggregation === null || typeof value.aggregation !== 'object'
          || (value.aggregation.method !== 'mean'
            && value.aggregation.method !== 'weighted-mean')
          || value.aggregation.missing !== 'require-complete'
          || !hasOnlyKeys(
            value.aggregation,
            value.aggregation.method === 'weighted-mean'
              ? ['method', 'missing', 'weights']
              : ['method', 'missing'],
          )) {
        return configurationFailure(
          'EVAL_RUNTIME_EVALUATOR_INVALID',
          'Rubric 评委 panel 配置无效。',
        );
      }
      const panelJudges = value.judges as readonly RubricJudgeMember[];
      if (panelJudges.some((member) => (
        member === null || typeof member !== 'object'
        || !hasOnlyKeys(member, ['memberId', 'model', 'judge', 'effort', 'replicateCount'])
      ))) {
        return configurationFailure(
          'EVAL_RUNTIME_EVALUATOR_INVALID',
          'Rubric 评委 member 配置无效。',
        );
      }
      const memberIds = panelJudges.map((member) => IdentifierSchema.parse(member.memberId));
      if (new Set(memberIds).size !== memberIds.length) {
        return configurationFailure(
          'EVAL_RUNTIME_EVALUATOR_INVALID',
          'Rubric 评委 memberId 必须唯一。',
        );
      }
      const replicateCounts = panelJudges.map((member) => member.replicateCount ?? 1);
      if (replicateCounts.some((count) => !Number.isSafeInteger(count) || count < 1)
          || replicateCounts.reduce((sum, count) => sum + count, 0)
            > MAX_RUBRIC_PANEL_COORDINATES) {
        return configurationFailure(
          'EVAL_RUNTIME_EVALUATOR_INVALID',
          `Rubric 评委 panel 最多包含 ${MAX_RUBRIC_PANEL_COORDINATES} 个测量坐标。`,
        );
      }
      const weights = value.aggregation.method === 'weighted-mean'
        ? value.aggregation.weights
        : undefined;
      if (weights !== undefined) {
        if (weights === null || Array.isArray(weights) || typeof weights !== 'object'
            || Object.keys(weights).sort(compareStrings).join('\u0000')
              !== [...memberIds].sort(compareStrings).join('\u0000')
            || memberIds.some((memberId) => (
              typeof weights[memberId] !== 'number'
              || !Number.isFinite(weights[memberId])
              || weights[memberId] <= 0
            ))
            || Math.abs(memberIds.reduce((sum, memberId) => sum + weights[memberId], 0) - 1)
              > 1e-12) {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Rubric 评委权重必须完整覆盖 member、为正数且总和为 1。',
          );
        }
      }
      const aggregationMembers: MeasurementAggregationPlan['members'][number][] = [];
      let metric: MetricDefinition | undefined;
      for (const [memberIndex, member] of panelJudges.entries()) {
        const memberId = memberIds[memberIndex];
        const replicateCount = replicateCounts[memberIndex];
        const invocation = captureJudge(member.judge);
        const replicates: MeasurementAggregationPlan['members'][number]['replicates'][number][] = [];
        for (let replicateIndex = 0; replicateIndex < replicateCount; replicateIndex += 1) {
          const evaluatorId = panelEvaluatorId(panelId, memberId, replicateIndex);
          const kit = createRubricJudgeKit({
            evaluatorId,
            metricId,
            model: member.model,
            invocation,
            ...(member.effort === undefined ? {} : { effort: member.effort }),
            ...(value.lengthDebias === undefined ? {} : { lengthDebias: value.lengthDebias }),
            ...(value.tracePolicy === undefined ? {} : { tracePolicy: value.tracePolicy }),
            ...(value.actualPointer === undefined ? {} : { actualPointer: value.actualPointer }),
            ...(value.tracePointer === undefined ? {} : { tracePointer: value.tracePointer }),
            ...(value.classification === undefined ? {} : { classification: value.classification }),
            ensembleMemberId: memberId,
            replicateGroupId: panelId,
            replicateIndex,
          });
          definitions.push(kit.evaluatorDefinition);
          metric ??= kit.metricDefinition;
          rubricEntries.push({
            kit,
            criterion: {
              schemaVersion: 'omk.rubric-judge-context/v1',
              ...value.rubric,
            },
          });
          replicates.push({
            evaluatorId,
            instrumentId: kit.evaluatorDefinition.measurement.instrumentId,
            replicateIndex,
          });
        }
        aggregationMembers.push({
          ensembleMemberId: memberId,
          ...(weights === undefined ? {} : { weight: weights[memberId] }),
          replicates,
        });
      }
      if (metric === undefined) {
        return configurationFailure(
          'EVAL_RUNTIME_EVALUATOR_INVALID',
          'Rubric 评委 panel 未产生 Metric。',
        );
      }
      metrics.push(metric);
      measurementAggregations.set(metricId, {
        method: value.aggregation.method,
        missing: 'require-complete',
        replicateGroupId: panelId,
        members: [...aggregationMembers].sort((left, right) => compareStrings(
          left.ensembleMemberId,
          right.ensembleMemberId,
        )),
      });
    }
  } catch (error) {
    if (error instanceof EvaluationConfigurationError) throw error;
    return configurationFailure(
      'EVAL_RUNTIME_EVALUATOR_INVALID',
      'Rubric 评委配置无效。',
    );
  }
  const evaluatorIds = definitions.map((definition) => definition.evaluatorId);
  const metricIds = metrics.map((metric) => metric.metricId);
  if (new Set(evaluatorIds).size !== evaluatorIds.length
      || new Set(metricIds).size !== metricIds.length) {
    return configurationFailure(
      'EVAL_RUNTIME_EVALUATOR_INVALID',
      'Evaluation evaluatorId 与 metricId 必须分别唯一。',
    );
  }
  let preparedDataset = dataset;
  if (rubricEntries.length > 0) {
    try {
      const samples = dataset.samples.map((sample) => {
        const base = sample.evaluationContext;
        if (base !== undefined
            && (base === null || Array.isArray(base) || typeof base !== 'object')) {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Rubric 评委要求用例的 evaluationContext 为 JSON object。',
          );
        }
        return {
          ...structuredClone(sample),
          evaluationContext: createRubricJudgeEvaluationContext(
            rubricEntries,
            base as Readonly<{ [key: string]: JsonValue }> | undefined,
          ),
        };
      });
      preparedDataset = captureDataset({ datasetId: dataset.datasetId, samples });
    } catch (error) {
      if (error instanceof EvaluationConfigurationError) throw error;
      return configurationFailure(
        'EVAL_RUNTIME_EVALUATOR_INVALID',
        'Rubric 评委 evaluationContext 无效。',
      );
    }
  }
  const registrations: RuntimePortRegistration<
    EvaluationEvaluator,
    EvaluatorRuntimeRequirement
  >[] = [];
  if (exactPorts.size > 0) {
    registrations.push({
      implementationId: EXACT_MATCH_EVALUATOR_IMPLEMENTATION_ID,
      createPort(requirement) {
        const port = exactPorts.get(requirement.referenceId);
        if (port === undefined) {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Evaluation Runtime 收到了未知 exact-match evaluator binding。',
          );
        }
        return port;
      },
    });
  }
  if (retrievalPorts.size > 0) {
    registrations.push({
      implementationId: RETRIEVAL_EVALUATOR_IMPLEMENTATION_ID,
      createPort(requirement) {
        const port = retrievalPorts.get(requirement.referenceId);
        if (port === undefined) {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Evaluation Runtime 收到了未知 retrieval evaluator binding。',
          );
        }
        return port;
      },
    });
  }
  if (abstentionPorts.size > 0) {
    registrations.push({
      implementationId: ABSTENTION_EVALUATOR_IMPLEMENTATION_ID,
      createPort(requirement) {
        const port = abstentionPorts.get(requirement.referenceId);
        if (port === undefined) {
          return configurationFailure('EVAL_RUNTIME_EVALUATOR_INVALID', 'Evaluation Runtime 收到了未知弃答 evaluator binding。');
        }
        return port;
      },
    });
  }
  if (toolTrajectoryPorts.size > 0) {
    registrations.push({
      implementationId: TOOL_TRAJECTORY_EVALUATOR_IMPLEMENTATION_ID,
      createPort(requirement) {
        const port = toolTrajectoryPorts.get(requirement.referenceId);
        if (port === undefined) {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Evaluation Runtime 收到了未知 tool trajectory evaluator binding。',
          );
        }
        return port;
      },
    });
  }
  if (rubricEntries.length > 0) {
    registrations.push(createRubricJudgeRegistration(
      rubricEntries.map((entry) => entry.kit),
    ));
  }
  for (const implementationId of [...new Set(customEntries.map(
    (entry) => entry.implementationId,
  ))].sort(compareStrings)) {
    const matchingEntries = customEntries.filter((entry) => (
      entry.implementationId === implementationId
    ));
    const versions = new Set(matchingEntries.map((entry) => entry.version));
    if (versions.size !== 1) {
      return configurationFailure(
        'EVAL_RUNTIME_EVALUATOR_INVALID',
        '同一 Custom Evaluator implementationId 在一次 Evaluation 中只能声明一个版本。',
      );
    }
    const version = matchingEntries[0]!.version;
    const ports = new Map(matchingEntries.map((entry) => [entry.evaluatorId, entry.port]));
    registrations.push({
      implementationId,
      satisfiesVersionConstraint: (constraint) => constraint === version,
      createPort(requirement) {
        const port = ports.get(requirement.referenceId);
        if (port === undefined) {
          return configurationFailure(
            'EVAL_RUNTIME_EVALUATOR_INVALID',
            'Evaluation Runtime 收到了未知 custom evaluator binding。',
          );
        }
        return port;
      },
    });
  }
  return Object.freeze({
    dataset: preparedDataset,
    definitions: Object.freeze([...definitions].sort((left, right) => (
      left.evaluatorId < right.evaluatorId ? -1 : left.evaluatorId > right.evaluatorId ? 1 : 0
    ))),
    metrics: Object.freeze([...metrics].sort((left, right) => (
      left.metricId < right.metricId ? -1 : left.metricId > right.metricId ? 1 : 0
    ))),
    measurementAggregations,
    registrations: Object.freeze(registrations),
  });
}
