import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  EvaluationDefinitionSchema,
  type JsonValue,
} from '../../src/eval-core/contracts/index.js';
import {
  evaluate,
  prepareEvaluation,
  type Clock,
  type EvaluateInput,
  type Executor,
  type RubricJudgeEvaluator,
  type ToolTrajectoryEvaluator,
} from '../../src/eval-runtime/index.js';
import {
  createToolTrajectoryEvaluatorIdentity,
  matchesToolTrajectory,
} from '../../src/eval-runtime/evaluators/tool-trajectory.js';
import {
  SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
  SourceNeutralTraceSchema,
} from '../../src/eval-runtime/contracts.js';

interface AgentConfig {
  readonly [key: string]: JsonValue;
  readonly traces: Readonly<Record<string, JsonValue>>;
}

const fixedClock: Clock = {
  monotonicNow: () => 0,
  timestamp: () => '2026-09-05T00:00:00.000Z',
  sleep: () => Promise.resolve(),
};

function trace(
  names: readonly string[],
  statuses: readonly ('success' | 'failure' | 'cancelled' | 'unknown')[] = [],
  roles: readonly ('standalone' | 'main' | 'subagent')[] = [],
): JsonValue {
  return {
    schemaVersion: SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
    turns: [],
    toolCalls: names.map((tool, index) => {
      const status = statuses[index] ?? 'success';
      return {
        tool,
        input: null,
        output: null,
        success: status === 'success',
        status,
        statusSource: 'runtime',
        ...(roles[index] === undefined ? {} : { traceRole: roles[index] }),
      };
    }),
    numTurns: 1,
    fullNumTurns: 1,
    numSubAgents: 0,
  };
}

function trajectoryEvaluator(
  match: ToolTrajectoryEvaluator['match'] = 'exact-order',
): ToolTrajectoryEvaluator {
  return {
    evaluatorKind: 'tool-trajectory',
    evaluatorId: 'tool-trajectory',
    metricId: 'tool-trajectory-match',
    tracePointer: '',
    expectedToolNamesPointer: '/expectedToolNames',
    match,
  };
}

function executor(
  seen: unknown[] = [],
  permissiveTrace = false,
): Executor<{ query: string }, AgentConfig, string, JsonValue> {
  return {
    executorId: 'test.agent/v1',
    version: '1.0.0',
    schemas: {
      input: z.object({ query: z.string() }).strict(),
      config: {
        parse(value) {
          return z.object({ traces: z.record(z.string(), z.json()) }).strict()
            .parse(value) as AgentConfig;
        },
      },
      output: z.string(),
      trace: {
        parse(value) {
          return (permissiveTrace
            ? z.json().parse(value)
            : SourceNeutralTraceSchema.parse(value)) as JsonValue;
        },
      },
    },
    outputClassification: 'public',
    traceClassification: 'sensitive',
    capabilities: {
      determinism: 'deterministic',
      cancellation: 'cooperative',
      concurrency: { safety: 'parallel-safe' },
      seedControl: 'unsupported',
      telemetry: { trace: 'required', usage: 'optional' },
    },
    fingerprintFacets: { revision: 'trajectory-one' },
    async execute(invocation) {
      seen.push(structuredClone(invocation));
      return {
        output: 'done',
        trace: invocation.config.traces[invocation.input.query] ?? trace([]),
      };
    },
  };
}

function input(
  declaration: Executor<{ query: string }, AgentConfig, string, JsonValue>,
  evaluator: ToolTrajectoryEvaluator = trajectoryEvaluator(),
  expectedToolNames: JsonValue = ['Search', 'Read'],
): EvaluateInput {
  return {
    dataset: {
      datasetId: 'agent-trajectory',
      samples: [{
        sampleId: 'research',
        input: { query: 'research' },
        expected: { expectedToolNames },
      }],
    },
    variants: [{
      variantId: 'agent-v1',
      artifact: {
        name: 'agent-v1', kind: 'agent', source: 'inline', content: 'Research with tools.',
      },
      execution: {
        executor: declaration,
        config: { traces: { research: trace(['Search', 'Read']) } },
      },
    }],
    evaluators: [evaluator],
    comparisons: [],
    analyses: [{
      analysisId: 'tool-trajectory-rate',
      analysisKind: 'summary',
      statistic: 'rate',
      variantId: 'agent-v1',
      metricId: 'tool-trajectory-match',
    }],
    experiment: { seed: 'trajectory-seed', sampling: { samplingKind: 'solo' } },
    policy: {},
  };
}

function observation(result: Awaited<ReturnType<typeof evaluate>>) {
  const record = result.artifacts?.evaluation?.records[0];
  if (record?.evaluationStatus !== 'completed') throw new Error('Expected evaluation evidence.');
  return record.observations[0];
}

describe('canonical tool trajectory evaluator', () => {
  it.each([
    ['exact-order', ['Search', 'Read'], ['Search', 'Read'], true],
    ['exact-order', ['Read', 'Search'], ['Search', 'Read'], false],
    ['exact-order', ['Search', 'Read', 'Write'], ['Search', 'Read'], false],
    ['same-tools', ['Read', 'Search'], ['Search', 'Read'], true],
    ['same-tools', ['Search', 'Read', 'Read'], ['Search', 'Read'], false],
    ['same-tools', ['Search', 'Read'], ['Search', 'Read', 'Read'], false],
    ['contains-in-order', ['List', 'Search', 'Edit', 'Read'], ['Search', 'Read'], true],
    ['contains-in-order', ['Read', 'Search'], ['Search', 'Read'], false],
    ['contains-any-order', ['Read', 'List', 'Search'], ['Search', 'Read'], true],
    ['contains-any-order', ['Search', 'Read'], ['Search', 'Read', 'Read'], false],
    ['contains-any-order', ['search', 'Read'], ['Search', 'Read'], false],
  ] as const)('%s compares %j against %j', (match, actual, expected, matches) => {
    expect(matchesToolTrajectory({
      actualToolNames: actual,
      expectedToolNames: expected,
      match,
    })).toBe(matches);
  });

  it('keeps empty and repeated trajectories explicit', () => {
    expect(matchesToolTrajectory({
      actualToolNames: [], expectedToolNames: [], match: 'exact-order',
    })).toBe(true);
    expect(matchesToolTrajectory({
      actualToolNames: [], expectedToolNames: [], match: 'same-tools',
    })).toBe(true);
    expect(matchesToolTrajectory({
      actualToolNames: ['Read', 'Read'],
      expectedToolNames: ['Read', 'Read'],
      match: 'same-tools',
    })).toBe(true);
    expect(() => matchesToolTrajectory({
      actualToolNames: [], expectedToolNames: [], match: 'contains-any-order',
    })).toThrow(TypeError);
    expect(() => matchesToolTrajectory({
      actualToolNames: [''], expectedToolNames: [], match: 'exact-order',
    })).toThrow(TypeError);
  });

  it('uses every source-neutral call status and keeps Gold out of Target invocation', async () => {
    const seen: unknown[] = [];
    const declaration = executor(seen);
    const base = input(
      declaration,
      trajectoryEvaluator('exact-order'),
      ['Search', 'Read', 'Edit', 'List'],
    );
    const result = await evaluate({
      ...base,
      variants: base.variants.map((variant) => ({
        ...variant,
        execution: {
          ...variant.execution,
          config: {
            traces: {
              research: trace(
                ['Search', 'Read', 'Edit', 'List'],
                ['success', 'failure', 'cancelled', 'unknown'],
                ['main', 'subagent', 'standalone', 'main'],
              ),
            },
          },
        },
      })),
    }, { runId: 'trajectory-statuses', clock: fixedClock });

    expect(result.status).toBe('completed');
    expect(observation(result)).toMatchObject({
      metricId: 'tool-trajectory-match',
      observationStatus: 'observed',
      valueType: 'boolean',
      value: true,
    });
    expect(observation(result)).not.toHaveProperty('evidence');
    expect(result.analysisResults['tool-trajectory-rate']).toMatchObject({
      analysisStatus: 'completed', value: 1,
    });
    expect(JSON.stringify(seen)).not.toContain('expectedToolNames');
    expect(result.definition.evaluators[0]).toMatchObject({
      evaluatorId: 'tool-trajectory',
      implementationId: 'omk.eval-runtime.tool-trajectory/v1',
      inputs: [
        { bindingId: 'trace', sourceKind: 'trace', pointer: '' },
        {
          bindingId: 'expected-tool-names',
          sourceKind: 'expected',
          pointer: '/expectedToolNames',
        },
      ],
      config: {
        match: 'exact-order',
        traceSchemaVersion: SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
        toolIdentityComparison: 'case-sensitive',
        toolCallCollection: 'top-level-toolCalls',
        toolCallOrder: 'array-order',
        toolCallSelection: 'all-statuses',
        traceRoleSelection: 'all',
        multiplicity: 'preserved',
      },
    });
  });

  it.each([
    {
      label: 'malformed trace',
      value: { toolCalls: [] },
      expected: ['Search'],
      evaluator: trajectoryEvaluator(),
      reason: 'tool-trajectory-trace-invalid',
    },
    {
      label: 'invalid Gold',
      value: trace(['Search']),
      expected: [1],
      evaluator: trajectoryEvaluator(),
      reason: 'tool-trajectory-expected-invalid',
    },
    {
      label: 'empty contains Gold',
      value: trace([]),
      expected: [],
      evaluator: trajectoryEvaluator('contains-any-order'),
      reason: 'tool-trajectory-expected-empty',
    },
  ])('fails closed for $label', async ({ value, expected, evaluator, reason }) => {
    const declaration = executor([], true);
    const base = input(declaration, evaluator, expected);
    const result = await evaluate({
      ...base,
      variants: base.variants.map((variant) => ({
        ...variant,
        execution: { ...variant.execution, config: { traces: { research: value } } },
      })),
      analyses: [],
    }, { runId: `invalid-${reason}`, clock: fixedClock });

    expect(result.status).toBe('completed');
    expect(observation(result)).toMatchObject({
      observationStatus: 'invalid', reasonCode: reason,
    });
  });

  it('keeps an unresolved binding as Core not-evaluated evidence', async () => {
    const result = await evaluate(input(
      executor(),
      { ...trajectoryEvaluator(), tracePointer: '/missing' },
    ), { runId: 'trajectory-missing-binding', clock: fixedClock });

    expect(result.status).toBe('completed');
    expect(result.artifacts?.evaluation?.records[0]).toMatchObject({
      evaluationStatus: 'not-evaluated',
      notEvaluatedReasonCode: 'evaluator-input-unavailable',
    });
  });

  it('consumes existing comparison, composite, Decision, and Rubric paths', async () => {
    const declaration = executor();
    const base = input(declaration);
    const variant = base.variants[0];
    if (variant === undefined) throw new Error('Expected base Variant.');
    const judge = {
      judgeId: 'test.trajectory-judge/v1',
      version: '1.0.0',
      providerCost: { reporting: 'unsupported' as const },
      fingerprintFacets: { revision: 'one' },
      invoke: async () => ({
        invocationStatus: 'completed' as const,
        output: '{"score":5,"reason":"complete"}',
      }),
    };
    const rubric = {
      evaluatorKind: 'rubric-judge',
      evaluatorId: 'answer-quality',
      metricId: 'answer-quality-score',
      rubric: { criterionId: 'quality', prompt: 'Judge the answer.', rubric: '5 is best.' },
      judges: [{ memberId: 'judge-one', model: 'judge-model', judge }],
      aggregation: { method: 'mean', missing: 'require-complete' },
    } satisfies RubricJudgeEvaluator;
    const result = await evaluate({
      ...base,
      dataset: {
        ...base.dataset,
        samples: [base.dataset.samples[0]!, {
          sampleId: 'research-two',
          input: { query: 'research-two' },
          expected: { expectedToolNames: ['Search', 'Read'] },
        }],
      },
      variants: [{
        ...variant,
        variantId: 'agent-v1',
        execution: {
          ...variant.execution,
          config: {
            traces: {
              research: trace(['Search']),
              'research-two': trace(['Search']),
            },
          },
        },
      }, {
        ...variant,
        variantId: 'agent-v2',
        artifact: { ...variant.artifact, name: 'agent-v2' },
        execution: {
          ...variant.execution,
          config: {
            traces: {
              research: trace(['Search', 'Read']),
              'research-two': trace(['Search', 'Read']),
            },
          },
        },
      }],
      evaluators: [trajectoryEvaluator(), rubric],
      comparisons: [{
        comparisonId: 'agent-v1-vs-v2',
        controlVariantId: 'agent-v1',
        treatmentVariantIds: ['agent-v2'],
        metricIds: ['tool-trajectory-match', 'answer-quality-score'],
      }],
      analyses: [{
        analysisId: 'agent-v2-trajectory-quality',
        analysisKind: 'quality-interval',
        statistic: 'mean',
        variantId: 'agent-v2',
        metricId: 'tool-trajectory-match',
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 32 },
      }, {
        analysisId: 'trajectory-difference',
        analysisKind: 'comparison-interval',
        statistic: 'mean-difference',
        comparisonId: 'agent-v1-vs-v2',
        treatmentVariantId: 'agent-v2',
        metricId: 'tool-trajectory-match',
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 32 },
      }, {
        analysisId: 'agent-overall-difference',
        analysisKind: 'composite-comparison-interval',
        compositeMetricId: 'agent-overall-quality',
        comparisonId: 'agent-v1-vs-v2',
        treatmentVariantId: 'agent-v2',
        components: [
          { metricId: 'tool-trajectory-match', weight: 0.5 },
          { metricId: 'answer-quality-score', weight: 0.5 },
        ],
        aggregation: { method: 'weighted-mean', missing: 'require-complete' },
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 32 },
      }],
      decision: {
        decisionKind: 'analysis', analysisId: 'agent-overall-difference', threshold: 0,
      },
      experiment: { seed: 'trajectory-comparison', sampling: { samplingKind: 'paired' } },
    }, { runId: 'trajectory-analysis', clock: fixedClock });

    expect(result.status).toBe('completed');
    expect(result.analysisResults['agent-v2-trajectory-quality']).toMatchObject({
      analysisStatus: 'completed', value: { estimate: 1 },
    });
    expect(result.analysisResults['trajectory-difference']).toMatchObject({
      analysisStatus: 'completed', value: { estimate: 1 },
    });
    expect(result.analysisResults['agent-overall-difference']).toMatchObject({
      analysisStatus: 'completed', value: { estimate: 0.5 },
    });
    expect(result.artifacts?.decision).toMatchObject({ decisionStatus: 'decided' });
  });

  it('canonicalizes key order and matches explicit Core assembly', async () => {
    const declaration = input(executor());
    const canonical = await prepareEvaluation(declaration);
    const reordered = await prepareEvaluation({
      ...declaration,
      evaluators: [{
        match: 'exact-order',
        expectedToolNamesPointer: '/expectedToolNames',
        tracePointer: '',
        metricId: 'tool-trajectory-match',
        evaluatorId: 'tool-trajectory',
        evaluatorKind: 'tool-trajectory',
      }],
    });
    const manual = EvaluationDefinitionSchema.parse({
      ...canonical.definition,
      evaluators: [{
        evaluatorId: 'tool-trajectory',
        evaluatorKind: 'assertion',
        implementationId: 'omk.eval-runtime.tool-trajectory/v1',
        measurement: {
          instrumentId: 'source-neutral-tool-trajectory-v1',
          ensembleMemberId: 'deterministic-local',
          replicateGroupId: 'deterministic-primary',
          replicateIndex: 0,
        },
        metricIds: ['tool-trajectory-match'],
        inputs: [
          { bindingId: 'trace', sourceKind: 'trace', pointer: '' },
          {
            bindingId: 'expected-tool-names',
            sourceKind: 'expected',
            pointer: '/expectedToolNames',
          },
        ],
        config: {
          match: 'exact-order',
          traceSchemaVersion: SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
          toolIdentityComparison: 'case-sensitive',
          toolCallCollection: 'top-level-toolCalls',
          toolCallOrder: 'array-order',
          toolCallSelection: 'all-statuses',
          traceRoleSelection: 'all',
          multiplicity: 'preserved',
        },
      }],
      metrics: [{
        metricId: 'tool-trajectory-match',
        valueType: 'boolean',
        scope: 'sample',
        direction: 'higher-is-better',
        missingPolicyId: 'exclude/v1',
      }],
    });
    const identity = createToolTrajectoryEvaluatorIdentity({
      evaluatorId: 'tool-trajectory',
      metricId: 'tool-trajectory-match',
      tracePointer: '',
      expectedToolNamesPointer: '/expectedToolNames',
      match: 'exact-order',
    });

    expect(reordered.definition).toEqual(canonical.definition);
    expect(reordered.planDigest).toBe(canonical.planDigest);
    expect(manual).toEqual(canonical.definition);
    expect(identity.capabilities).toMatchObject({
      inputSourceKinds: ['expected', 'trace'],
      schemas: [],
    });
    const [left, right] = await Promise.all([
      canonical.run({ runId: 'trajectory-equivalent', clock: fixedClock }),
      reordered.run({ runId: 'trajectory-equivalent', clock: fixedClock }),
    ]);
    expect(right.artifacts).toEqual(left.artifacts);
  });

  it('rejects invalid declarations before Target execution', async () => {
    const seen: unknown[] = [];
    const declaration = input(executor(seen));
    await expect(prepareEvaluation({
      ...declaration,
      evaluators: [{
        ...trajectoryEvaluator(), match: 'subset',
      } as unknown as ToolTrajectoryEvaluator],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });
    await expect(prepareEvaluation({
      ...declaration,
      evaluators: [{ ...trajectoryEvaluator(), tracePointer: 'toolCalls' }],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });
    expect(seen).toHaveLength(0);
  });
});
