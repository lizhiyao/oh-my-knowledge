import { describe, expect, it } from "vitest";
import { EvaluationConfigurationError, evaluate, executeEvaluation, prepareEvaluation, scoreExecutedEvaluation, type Clock, type CustomEvaluator, type EventObserver } from "../../../src/eval-runtime/index.js";
import { EVALUATION_DEFINITION_SCHEMA_VERSION, EvaluationDefinitionSchema, digestCanonicalJson } from "../../../src/eval-core/contracts/index.js";
import { type Config, comparisonAnalysis, controlSpec, executor, fixedClock, numericCustomEvaluator, pairedInput, stableFacadeId, treatmentSpec } from '../fixtures/evaluation.js';

describe('canonical eval-runtime prepare', () => {
it('prepares one immutable executable Plan without calling a Target or Evaluator', async () => {
    let targetInvocations = 0;
    const declaration = executor(async ({ input, config, signal }) => {
      targetInvocations += 1;
      signal.throwIfAborted();
      return { output: config.answers[input.prompt] };
    });
    const input = pairedInput(declaration);
    const prepared = await prepareEvaluation(input);
    const sealedDefinition = digestCanonicalJson(prepared.definition);

    expect(targetInvocations).toBe(0);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.plan)).toBe(true);
    expect(Object.isFrozen(prepared.definition.dataset.samples)).toBe(true);
    expect(prepared.definition).toBe(prepared.plan.definition);
    expect(prepared.policy).toBe(prepared.plan.measurementPolicy);
    expect(prepared.planDigest).toBe(prepared.plan.digests.runContractDigest);
    expect(prepared.estimatedWork).toEqual({
      sampleCount: 2,
      variantCount: 2,
      trialCount: 1,
      executionCoordinates: 4,
      evaluationCoordinates: 4,
      plannedInvocations: 8,
      uncertain: [
        'early-termination',
        'active-duration',
        'wall-clock',
        'provider-cost',
      ],
    });
    expect(prepared.resolvedRuntimes.map(({ runtimeKind }) => runtimeKind)).toEqual(
      expect.arrayContaining(['executor', 'evaluator', 'analysis-node', 'decision-policy']),
    );

    input.dataset.samples[0].input.prompt = 'two';
    (input.variants[1].execution as { config?: Config; }).config = {
      answers: { ...input.variants[1].execution.config!.answers, one: 'wrong' },
    };
    input.analyses[0].confidence.resamples = 32;
    input.policy.execution.maxConcurrency = 1;

    const result = await prepared.run({ runId: 'prepared-immutable', clock: fixedClock });
    expect(result.status).toBe('completed');
    expect(result.runId).toBe('prepared-immutable');
    expect(targetInvocations).toBe(4);
    expect(digestCanonicalJson(result.definition)).toBe(sealedDefinition);
    expect(result.definition).toBe(prepared.definition);
    expect(result.policy).toBe(prepared.policy);
    if (result.status !== 'completed') return;
    expect(result.artifacts.execution.runContractDigest).toBe(prepared.planDigest);
  });

it('makes direct evaluate canonically equivalent and generates an omitted runId', async () => {
    const input = pairedInput();
    const prepared = await prepareEvaluation(input);
    const direct = await evaluate(input, { clock: fixedClock });
    const staged = await prepared.run({ clock: fixedClock });

    expect(direct.runId).toMatch(/^run-[0-9a-f-]{36}$/u);
    expect(staged.runId).toMatch(/^run-[0-9a-f-]{36}$/u);
    expect(staged.runId).not.toBe(direct.runId);
    expect(staged.definition).toEqual(direct.definition);
    expect(staged.policy).toEqual(direct.policy);
    expect(staged.status).toBe('completed');
    expect(direct.status).toBe('completed');
    if (staged.status !== 'completed' || direct.status !== 'completed') return;
    expect(staged.artifacts.execution.runContractDigest)
      .toBe(direct.artifacts.execution.runContractDigest);
    expect(staged.artifacts.execution.executionPlanDigest)
      .toBe(direct.artifacts.execution.executionPlanDigest);
    expect(staged.artifacts.evaluation.evaluationPlanDigest)
      .toBe(direct.artifacts.evaluation.evaluationPlanDigest);
    expect(staged.artifacts.analysis.analysisPlanDigest)
      .toBe(direct.artifacts.analysis.analysisPlanDigest);
  });

it('captures direct run options before asynchronous preparation', async () => {
    const options = { runId: 'captured-run-options', clock: fixedClock };
    const pending = evaluate(pairedInput(), options);
    options.runId = 'mutated-run-options';

    const result = await pending;
    expect(result.runId).toBe('captured-run-options');

    // The staged score entry also prepares before it runs, so run identity and event sinks must
    // bind at entry: a host that recycles one options object across scored versions cannot
    // misroute this Run's identity, cancellation or event delivery.
    const declaration = pairedInput();
    const executed = await executeEvaluation(declaration, {
      runId: 'staged-capture-source',
      clock: fixedClock,
    });
    const capturedEvents: number[] = [];
    const lateEvents: number[] = [];
    const scoreOptions: { runId: string; clock: Clock; onEvent: EventObserver } = {
      runId: 'captured-score-run-options',
      clock: fixedClock,
      onEvent: (event) => {
        capturedEvents.push(event.sequence);
      },
    };
    const pendingScore = scoreExecutedEvaluation(declaration, executed, scoreOptions);
    scoreOptions.runId = 'mutated-score-run-options';
    scoreOptions.onEvent = (event) => {
      lateEvents.push(event.sequence);
    };

    const scored = await pendingScore;
    expect(scored.status).toBe('completed');
    expect(scored.runId).toBe('captured-score-run-options');
    expect(capturedEvents.length).toBeGreaterThan(0);
    expect(lateEvents).toEqual([]);
  });

it('strictly separates declaration fields from run options before Target calls', async () => {
    let invocations = 0;
    const input = pairedInput(executor(async () => {
      invocations += 1;
      return { output: 'A' };
    }));

    await expect(prepareEvaluation({ ...input, runId: 'old-shape' } as never))
      .rejects.toBeInstanceOf(EvaluationConfigurationError);
    await expect(evaluate(input, { runId: 'valid', legacy: true } as never))
      .rejects.toBeInstanceOf(EvaluationConfigurationError);
    await expect(evaluate(input, { signal: {} } as never))
      .rejects.toBeInstanceOf(EvaluationConfigurationError);
    expect(invocations).toBe(0);
  });

it('captures the active callback and changes Runtime identity when declared facets change', async () => {
    const input = pairedInput();
    const custom = numericCustomEvaluator(
      'captured-callback',
      () => ({
        resultKind: 'completed',
        results: [{ metricId: 'captured-callback-score', resultKind: 'score', value: 1 }],
      }),
      'revision-one',
    );
    const pending = evaluate({
      ...input,
      evaluators: [custom],
      comparisons: [{ ...input.comparisons[0], metricIds: ['captured-callback-score'] }],
      analyses: comparisonAnalysis('captured-callback-score'),
      decision: undefined
    }, {
      runId: 'custom-evaluator-captured-callback',
      clock: fixedClock
    });
    (custom.implementation as {
      evaluate: CustomEvaluator<{ actual: string; }>['implementation']['evaluate'];
    }).evaluate = () => ({
      resultKind: 'completed',
      results: [{ metricId: 'captured-callback-score', resultKind: 'score', value: 99 }],
    });
    const first = await pending;
    const second = await evaluate({
      ...input,
      evaluators: [numericCustomEvaluator('captured-callback', () => ({
        resultKind: 'completed',
        results: [{ metricId: 'captured-callback-score', resultKind: 'score', value: 1 }],
      }), 'revision-two')],
      comparisons: [{ ...input.comparisons[0], metricIds: ['captured-callback-score'] }],
      analyses: comparisonAnalysis('captured-callback-score'),
      decision: undefined
    }, {
      runId: 'custom-evaluator-new-identity',
      clock: fixedClock
    });

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    if (first.status !== 'completed' || second.status !== 'completed') return;
    expect(first.artifacts.evaluation.records.flatMap((record) => (
      record.evaluationStatus === 'completed' ? record.observations : []
    )).every((observation) => (
      observation.observationStatus === 'observed' && observation.value === 1
    ))).toBe(true);
    expect(first.artifacts.evaluation.records[0].runtime.fingerprint)
      .not.toBe(second.artifacts.evaluation.records[0].runtime.fingerprint);
    expect(first.artifacts.evaluation.evaluationPlanDigest)
      .not.toBe(second.artifacts.evaluation.evaluationPlanDigest);
  });

it('compiles equivalent declarations to one canonical Core Definition', async () => {
    const declaration = executor();
    const common = pairedInput(declaration);
    const first = await evaluate({ ...common }, {
      clock: fixedClock
    });
    const second = await evaluate({
      ...common,
      variants: [...common.variants].reverse(),
      comparisons: [{
        ...common.comparisons[0],
        treatmentVariantIds: [...common.comparisons[0].treatmentVariantIds].reverse(),
        metricIds: [...common.comparisons[0].metricIds].reverse(),
      }]
    }, {
      clock: fixedClock
    });

    const selector = { analysisId: 'baseline-vs-candidate-correct' };
    const resultId = 'baseline-vs-candidate-correct';
    const expected = EvaluationDefinitionSchema.parse({
      schemaVersion: EVALUATION_DEFINITION_SCHEMA_VERSION,
      dataset: common.dataset,
      targets: [controlSpec, treatmentSpec].map((spec) => ({
        targetId: spec.variantId,
        targetKind: spec.artifact.kind,
        protocolId: 'omk.invoke/v1',
        executorId: declaration.executorId,
        executionRequirements: {
          systemInstructions: 'not-required', workspace: 'not-required',
          mcp: 'not-required', mockInterception: 'not-required',
          toolPolicy: 'runtime-default', skillDiscovery: 'runtime-default',
        },
        executionControls: {
          defaults: {
            workspace: { workspaceMode: 'not-required' },
            tools: { toolPolicyKind: 'runtime-default' },
            mcp: { mcpMode: 'not-required' },
            mockInterception: { mockInterceptionMode: 'not-required' },
          },
          sampleOverrides: [],
        },
        config: {
          schemaVersion: 'omk.eval-runtime.variant-config/v3',
          artifact: spec.artifact,
          ...('runtimeContext' in spec ? { runtimeContext: spec.runtimeContext } : {}),
          executorConfig: spec.config,
        },
      })),
      evaluators: [{
        evaluatorId: 'exact-match',
        evaluatorKind: 'assertion',
        implementationId: 'omk.eval-runtime.exact-match/v1',
        measurement: {
          instrumentId: 'canonical-json-exact-match-v1',
          ensembleMemberId: 'deterministic-local',
          replicateGroupId: 'deterministic-primary',
          replicateIndex: 0,
        },
        metricIds: ['correct'],
        inputs: [
          { bindingId: 'actual', sourceKind: 'output', pointer: '' },
          { bindingId: 'expected', sourceKind: 'expected', pointer: '' },
        ],
      }],
      metrics: [{
        metricId: 'correct', valueType: 'boolean', scope: 'sample',
        direction: 'higher-is-better', missingPolicyId: 'exclude/v1',
      }],
      experiment: {
        trials: 1,
        seed: 'fixed-seed',
        assignment: {
          assignmentKind: 'complete-block',
          algorithmId: 'assignment.complete-block/v1',
          randomizationSlotIds: ['prompt-v1', 'prompt-v2'].map((variantId) => (
            stableFacadeId('slot', { variantId })
          )).sort(),
        },
        sampling: {
          experimentalUnit: 'sample', pairingKey: '/sampleId', repeatedMeasures: false,
          resamplingUnit: 'paired-block',
          estimatorId: 'bootstrap.paired-difference-percentile/v1',
          seedCoupling: 'shared-within-block',
        },
        scheduling: { schedulingKind: 'interleaved' },
        randomizationSlots: ['prompt-v1', 'prompt-v2'].map((variantId) => ({
          targetId: variantId,
          randomizationSlotId: stableFacadeId('slot', { variantId }),
        })).sort((left, right) => (
          left.randomizationSlotId < right.randomizationSlotId ? -1
            : left.randomizationSlotId > right.randomizationSlotId ? 1 : 0
        )),
      },
      analysisGraph: {
        analysisMode: 'preregistered',
        nodes: [{
          analysisNodeKind: 'estimator',
          nodeId: stableFacadeId('node', selector),
          implementationId: 'bootstrap.paired-difference-percentile/v1',
          inputs: [
            { inputKind: 'metric-observations', referenceId: 'correct' },
            {
              inputKind: 'comparison', referenceId: 'baseline-vs-candidate',
              treatmentTargetId: 'prompt-v2', metricId: 'correct',
            },
          ],
          outputResultId: resultId,
          parameters: { resamples: 100, alpha: 0.05 },
        }],
      },
      comparisons: [{
        comparisonId: 'baseline-vs-candidate', controlTargetId: 'prompt-v1',
        treatmentTargetIds: ['prompt-v2'], metricIds: ['correct'],
      }],
      decisionPolicy: {
        decisionPolicyId: stableFacadeId('decision', {
          decisionKind: 'analysis', resultId,
        }),
        implementationId: 'progress/v2',
        analysisResultIds: [resultId],
        comparisonFamily: [{
          comparisonId: 'baseline-vs-candidate', treatmentTargetId: 'prompt-v2',
          metricId: 'correct', analysisResultId: resultId,
        }],
        minimumEvidenceStatus: 'complete',
        parameters: { threshold: 0, equivalence: 0 },
      },
    });

    expect(EvaluationDefinitionSchema.parse(first.definition)).toEqual(first.definition);
    expect(first.definition).toEqual(expected);
    expect(second.definition).toEqual(first.definition);
    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    if (first.status !== 'completed' || second.status !== 'completed') return;
    expect(second.artifacts.execution.executionPlanDigest)
      .toBe(first.artifacts.execution.executionPlanDigest);
    expect(second.artifacts.evaluation.evaluationPlanDigest)
      .toBe(first.artifacts.evaluation.evaluationPlanDigest);
    expect(second.artifacts.analysis.analysisPlanDigest)
      .toBe(first.artifacts.analysis.analysisPlanDigest);
    expect(first.definition.experiment.randomizationSlots.map((slot) => slot.randomizationSlotId))
      .toEqual([
        stableFacadeId('slot', { variantId: 'prompt-v1' }),
        stableFacadeId('slot', { variantId: 'prompt-v2' }),
      ]);
    expect(first.definition.analysisGraph.nodes[0]).toMatchObject({
      nodeId: stableFacadeId('node', selector),
      outputResultId: resultId,
    });
    expect(first.definition.decisionPolicy?.decisionPolicyId).toBe(stableFacadeId('decision', {
      decisionKind: 'analysis',
      resultId: first.definition.analysisGraph.nodes[0].outputResultId,
    }));
  });

it('canonicalizes Analysis request and cohort-filter declaration order', async () => {
    const declaration = executor();
    const base = pairedInput(declaration);
    const dataset = {
      ...base.dataset,
      analysisCohorts: [{
        cohortId: 'alpha',
        cohortSetId: 'tags',
        cohortSetKind: 'cohort' as const,
        classification: 'public' as const,
        disclosure: 'identity-only' as const,
      }, {
        cohortId: 'beta',
        cohortSetId: 'tags',
        cohortSetKind: 'cohort' as const,
        classification: 'public' as const,
        disclosure: 'identity-only' as const,
      }],
      samples: base.dataset.samples.map((sample) => ({
        ...sample,
        analysis: { memberships: [{ cohortId: 'alpha' }, { cohortId: 'beta' }] },
      })),
    };
    const analyses = [{
      analysisId: 'candidate-rate',
      analysisKind: 'summary' as const,
      statistic: 'rate' as const,
      variantId: treatmentSpec.variantId,
      metricId: 'correct',
      cohortFilter: { includeCohortIds: ['beta', 'alpha'] },
    }, {
      analysisId: 'comparison-interval',
      analysisKind: 'comparison-interval' as const,
      statistic: 'mean-difference' as const,
      comparisonId: 'baseline-vs-candidate',
      treatmentVariantId: treatmentSpec.variantId,
      metricId: 'correct',
      confidence: { method: 'percentile-bootstrap' as const, level: 0.95, resamples: 32 },
    }];

    const first = await evaluate({
      ...base,
      dataset,
      analyses,
      decision: undefined
    }, {
      runId: 'analysis-order-first',
      clock: fixedClock
    });
    const second = await evaluate({
      ...base,
      dataset,
      analyses: [...analyses].reverse().map((request) => (request.analysisKind === 'summary'
        ? { ...request, cohortFilter: { includeCohortIds: ['alpha', 'beta'] } }
        : request)),
      decision: undefined
    }, {
      runId: 'analysis-order-second',
      clock: fixedClock
    });

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    expect(second.definition).toEqual(first.definition);
  });
});
