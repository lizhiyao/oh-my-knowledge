import { describe, expect, it, vi } from "vitest";
import { EvaluationConfigurationError, assessComparability, evaluate, reanalyze, redecide, rescore } from "../../../src/eval-runtime/index.js";
import { comparisonAnalysis, controlSpec, executor, fixedClock, numericCustomEvaluator, pairedInput, treatmentSpec } from '../fixtures/evaluation.js';

describe('canonical eval-runtime reuse', () => {
it('re-scores changed Gold without invoking Targets again', async () => {
    let targetInvocations = 0;
    const declaration = executor(async ({ input, config, signal }) => {
      targetInvocations += 1;
      signal.throwIfAborted();
      return { output: config.answers[input.prompt] };
    });
    const sourceInput = pairedInput(declaration);
    const source = await evaluate(sourceInput, { runId: 'rescore-source', clock: fixedClock });
    expect(targetInvocations).toBe(4);

    const changed = pairedInput(declaration);
    changed.dataset.samples[0].expected = 'wrong';
    const result = await rescore(changed, source, {
      runId: 'rescore-result',
      clock: fixedClock,
    });

    expect(targetInvocations).toBe(4);
    expect(result.status).toBe('completed');
    expect(result.artifacts?.execution).toBe(source.artifacts?.execution);
    expect(result.artifacts?.evaluation?.bundleDigest)
      .not.toBe(source.artifacts?.evaluation?.bundleDigest);
    expect(result.artifacts?.analysis?.bundleDigest)
      .not.toBe(source.artifacts?.analysis?.bundleDigest);
    expect(result.report?.reportDigest).not.toBe(source.report?.reportDigest);
  });

it('re-analyzes with a new analysis design without invoking Targets or Evaluators again', async () => {
    let targetInvocations = 0;
    const evaluatorInvocations = vi.fn();
    const declaration = executor(async ({ input, config, signal }) => {
      targetInvocations += 1;
      signal.throwIfAborted();
      return { output: config.answers[input.prompt] };
    });
    const custom = numericCustomEvaluator('length', ({ bindings }) => {
      evaluatorInvocations();
      return {
        resultKind: 'completed',
        results: [{ metricId: 'length-score', resultKind: 'score', value: bindings.actual.length }],
      };
    });
    const sourceBase = pairedInput(declaration);
    const sourceInput = {
      ...sourceBase,
      evaluators: [custom],
      comparisons: [{
        comparisonId: 'baseline-vs-candidate',
        controlVariantId: controlSpec.variantId,
        treatmentVariantIds: [treatmentSpec.variantId],
        metricIds: ['length-score'],
      }],
      analyses: comparisonAnalysis('length-score'),
      decision: {
        decisionKind: 'analysis' as const,
        analysisId: 'length-score-difference',
      },
    };
    const source = await evaluate(sourceInput, {
      runId: 'reanalyze-source',
      clock: fixedClock,
    });
    expect(targetInvocations).toBe(4);
    expect(evaluatorInvocations).toHaveBeenCalledTimes(4);
    evaluatorInvocations.mockClear();

    const changedBase = pairedInput(declaration);
    const changed = {
      ...sourceInput,
      dataset: changedBase.dataset,
      variants: changedBase.variants,
      evaluators: sourceInput.evaluators,
      analyses: comparisonAnalysis('length-score'),
    };
    changed.analyses[0].confidence.resamples = 200;
    const result = await reanalyze(changed, source, {
      runId: 'reanalyze-result',
      clock: fixedClock,
    });

    expect(targetInvocations).toBe(4);
    expect(evaluatorInvocations).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(result.artifacts?.execution).toBe(source.artifacts?.execution);
    expect(result.artifacts?.evaluation).toBe(source.artifacts?.evaluation);
    expect(result.artifacts?.analysis?.bundleDigest)
      .not.toBe(source.artifacts?.analysis?.bundleDigest);
  });

it('re-decides with a new policy without invoking Targets or Evaluators again', async () => {
    let targetInvocations = 0;
    const declaration = executor(async ({ input, config, signal }) => {
      targetInvocations += 1;
      signal.throwIfAborted();
      return { output: config.answers[input.prompt] };
    });
    const sourceInput = pairedInput(declaration);
    const source = await evaluate(sourceInput, { runId: 'redecide-source', clock: fixedClock });
    const changedBase = pairedInput(declaration);
    const changed = {
      ...changedBase,
      decision: { ...changedBase.decision, threshold: 0.75 },
    };
    const result = await redecide(changed, source, {
      runId: 'redecide-result',
      clock: fixedClock,
    });

    expect(targetInvocations).toBe(4);
    expect(result.status).toBe('completed');
    expect(result.artifacts?.execution).toBe(source.artifacts?.execution);
    expect(result.artifacts?.evaluation).toBe(source.artifacts?.evaluation);
    expect(result.artifacts?.analysis).toBe(source.artifacts?.analysis);
    expect(result.artifacts?.decision?.decisionDigest)
      .not.toBe(source.artifacts?.decision?.decisionDigest);
  });

it('reports the underlying Core configuration code when a reuse suffix fails closed', async () => {
    let targetInvocations = 0;
    const declaration = executor(async ({ input: invocationInput, config }) => {
      targetInvocations += 1;
      return { output: config.answers[invocationInput.prompt] };
    });
    const input = pairedInput(declaration);
    const durable = {
      ...input,
      policy: { ...input.policy, eventDelivery: { writerMode: 'required' as const } },
    };
    const source = await evaluate(durable, {
      runId: 'reuse-writer-required-source',
      eventWriter: { write: async () => {} },
    });
    expect(source.status).toBe('completed');
    targetInvocations = 0;

    const suffixes = [
      ['rescore', rescore, 'EVALUATION_RUNTIME_EVENT_WRITER_REQUIRED'],
      ['reanalyze', reanalyze, 'ANALYSIS_RUNTIME_EVENT_WRITER_REQUIRED'],
      ['redecide', redecide, 'DECISION_EVENT_WRITER_REQUIRED'],
    ] as const;
    for (const [name, run, code] of suffixes) {
      await expect(run(durable, source, { runId: `reuse-writer-required-${name}` })).rejects
        .toMatchObject({
          code: 'EVAL_RUNTIME_REUSE_INVALID',
          message: 'Evaluation stage reuse 因 Run 配置错误失败关闭。',
          cause: { failureKind: 'configuration', code },
        });
    }
    expect(targetInvocations).toBe(0);

    // Same entry point, different failure class: `policy.eventDelivery` is part of the run
    // contract identity only, never a stage plan digest, so changing it cannot break the
    // reusable prefix. Rejecting the source itself needs a declaration change, and that
    // rejection carries no wrapped origin.
    const changed = {
      ...durable,
      variants: durable.variants.map((current, index) => index === 1 ? {
        ...current,
        artifact: { ...current.artifact, content: 'Changed execution input.' },
      } : current),
    };
    const rejection: unknown = await rescore(changed, source, {
      runId: 'reuse-premise-mismatch',
    }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(EvaluationConfigurationError);
    const premiseFailure = rejection as EvaluationConfigurationError;
    expect(premiseFailure.code).toBe('EVAL_RUNTIME_REUSE_INVALID');
    expect(premiseFailure.message)
      .toBe('Evaluation source result 与新声明的可复用阶段不一致。');
    expect('cause' in premiseFailure).toBe(false);
  });

it('rejects cloned results and incompatible reusable prefixes before invoking a Target', async () => {
    let targetInvocations = 0;
    const declaration = executor(async ({ input, config }) => {
      targetInvocations += 1;
      return { output: config.answers[input.prompt] };
    });
    const sourceInput = pairedInput(declaration);
    const source = await evaluate(sourceInput, { runId: 'reuse-validation-source' });
    targetInvocations = 0;

    await expect(rescore(sourceInput, structuredClone(source), {
      runId: 'reuse-cloned-source',
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_REUSE_INVALID' });
    const changed = pairedInput(declaration);
    changed.variants[1] = {
      ...changed.variants[1],
      artifact: { ...changed.variants[1].artifact, content: 'Changed execution input.' },
    };
    await expect(rescore(changed, source, {
      runId: 'reuse-incompatible-source',
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_REUSE_INVALID' });
    expect(targetInvocations).toBe(0);
  });

it('recursively rejects changes owned by every skipped parent stage', async () => {
    const sourceInput = pairedInput();
    const source = await evaluate(sourceInput, { runId: 'reuse-parent-source' });
    const changedGold = pairedInput();
    changedGold.dataset.samples[0].expected = 'wrong';
    await expect(reanalyze(changedGold, source, {
      runId: 'reuse-changed-gold',
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_REUSE_INVALID' });

    const changedAnalysis = pairedInput();
    changedAnalysis.analyses[0].confidence.resamples = 200;
    await expect(redecide(changedAnalysis, source, {
      runId: 'reuse-changed-analysis',
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_REUSE_INVALID' });
  });

it('validates a re-decision declaration before reading its Decision', async () => {
    const source = await evaluate(pairedInput(), { runId: 'reuse-invalid-input-source' });

    await expect(redecide(null as never, source, {
      runId: 'reuse-invalid-input',
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
  });

it('uses the sealed Decision snapshot when the caller mutates input after invocation', async () => {
    type MutableInput = Omit<ReturnType<typeof pairedInput>, 'decision'> & {
      decision?: ReturnType<typeof pairedInput>['decision'];
    };
    const source = await evaluate(pairedInput(), { runId: 'reuse-decision-snapshot-source' });
    const addedAfterInvocation: MutableInput = pairedInput();
    delete addedAfterInvocation.decision;
    const rejected = redecide(addedAfterInvocation, source, {
      runId: 'reuse-decision-added-late',
    });
    addedAfterInvocation.decision = {
      decisionKind: 'analysis',
      analysisId: 'baseline-vs-candidate-correct',
    };
    await expect(rejected).rejects.toMatchObject({ code: 'EVAL_RUNTIME_REUSE_INVALID' });

    const removedAfterInvocation: MutableInput = pairedInput();
    const accepted = redecide(removedAfterInvocation, source, {
      runId: 'reuse-decision-removed-late',
    });
    delete removedAfterInvocation.decision;
    await expect(accepted).resolves.toMatchObject({
      status: 'completed',
      artifacts: { decision: { decisionStatus: 'decided' } },
    });
  });

it('materializes a cancelled suffix run from an already-aborted caller signal', async () => {
    const input = pairedInput();
    const source = await evaluate(input, { runId: 'reuse-cancel-source' });
    const controller = new AbortController();
    controller.abort(new Error('caller cancellation'));

    const result = await rescore(input, source, {
      runId: 'reuse-cancel-result',
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(result.report?.status.runStatus).toBe('cancelled');
  });

it('assesses independent Runs through their authenticated Core source chains', async () => {
    const input = pairedInput();
    const left = await evaluate(input, { runId: 'comparability-left', clock: fixedClock });
    const changed = pairedInput();
    const right = await evaluate({
      ...changed,
      variants: changed.variants.map((candidate) => (
        candidate.variantId === treatmentSpec.variantId
          ? {
              ...candidate,
              artifact: { ...candidate.artifact, content: 'Answer exactly and briefly.' },
            }
          : candidate
      )),
    }, { runId: 'comparability-right', clock: fixedClock });

    const assessment = assessComparability({
      comparisonScope: 'decision',
      subjects: [{
        subjectId: 'candidate-under-test',
        leftVariantId: treatmentSpec.variantId,
        rightVariantId: treatmentSpec.variantId,
      }],
      left,
      right,
    });

    expect(assessment.designStatus).toBe('compatible');
    expect(assessment.reasons).toContainEqual(expect.objectContaining({
      reasonCode: 'comparability-identity-declared-subject-change',
      axis: 'identity',
    }));
    expect(assessment.reasons.map((reason) => reason.reasonCode)).not.toContain(
      'comparability-evidence-source-absent',
    );
    expect(assessment.reasons.map((reason) => reason.reasonCode)).not.toContain(
      'comparability-evidence-verification-indeterminate',
    );
    expect(Object.isFrozen(assessment)).toBe(true);

    const evaluationScope = assessComparability({
      comparisonScope: 'evaluation',
      subjects: [{
        subjectId: 'candidate-under-test',
        leftVariantId: treatmentSpec.variantId,
        rightVariantId: treatmentSpec.variantId,
      }],
      left,
      right,
    });
    expect(evaluationScope.designStatus).toBe('compatible');

    const invalidMapping = assessComparability({
      comparisonScope: 'analysis',
      subjects: [{
        subjectId: 'unknown-candidate',
        leftVariantId: 'missing',
        rightVariantId: treatmentSpec.variantId,
      }],
      left,
      right,
    });
    expect(invalidMapping.designStatus).toBe('incompatible');
    expect(invalidMapping.reasons).toContainEqual(expect.objectContaining({
      reasonCode: 'comparability-design-subject-mapping-invalid',
    }));

    expect(() => assessComparability({
      comparisonScope: 'evaluation',
      subjects: [{
        subjectId: 'candidate-under-test',
        leftVariantId: treatmentSpec.variantId,
        rightVariantId: treatmentSpec.variantId,
      }],
      left: structuredClone(left),
      right,
    })).toThrowError(expect.objectContaining({
      code: 'EVAL_RUNTIME_COMPARABILITY_INVALID',
    }));
  });
});
