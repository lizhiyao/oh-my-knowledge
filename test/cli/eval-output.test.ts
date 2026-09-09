import { describe, expect, it } from 'vitest';
import { formatEvaluationInputFailure, formatEvaluationSummary } from '../../src/cli/lib/eval-output.js';
import { CliEvaluationInputError } from '../../src/eval-workflows/hosts/application.js';

const outcome = {
  projectionKind: 'core-cli-run-outcome', runId: 'acceptance-run',
  status: { runStatus: 'completed', evidenceStatus: 'complete', conclusionStatus: 'conclusive' },
  stages: {
    execution: { coverage: { planned: 6, succeeded: 6, failed: 0, cancelled: 0, budgetCensored: 0, notStarted: 0 } },
    evaluation: { coverage: { planned: 6, completed: 6, failed: 0, sourceUnavailable: 0 } },
  },
  decision: { decisionStatus: 'decided', verdict: 'UNDERPOWERED', reasonCodes: ['comparison-sample-size-below-minimum'] },
  gate: { gateStatus: 'skipped', reasonCodes: ['core-report-only'] },
};

describe('eval terminal output', () => {
  it('shows the verdict and sample-size action even when report-only exits successfully', () => {
    const before = structuredClone(outcome);
    const text = formatEvaluationSummary(outcome, 'zh');
    expect(text).toContain('评测结论：UNDERPOWERED');
    expect(text).toContain('当前不能作为发布依据');
    expect(text).toContain('6/6 成功');
    expect(text).toContain('comparison-sample-size-below-minimum');
    expect(text).toContain('core-report-only');
    expect(outcome).toEqual(before);
  });

  it('prioritizes missing evidence over a supplied positive verdict', () => {
    const text = formatEvaluationSummary({ ...outcome,
      status: { ...outcome.status, evidenceStatus: 'unresolvable', conclusionStatus: 'inconclusive' },
      stages: { ...outcome.stages, execution: { coverage: { ...outcome.stages.execution.coverage, succeeded: 0, failed: 6 } } },
      decision: { ...outcome.decision, verdict: 'PROGRESS' },
    }, 'en');
    expect(text).toContain('0/6 succeeded, 6 failed');
    expect(text).toContain('inspect failed calls and missing evidence');
    expect(text).not.toContain('entering your release process');
  });

  it('keeps a blocked gate visible when the verdict is positive', () => {
    const text = formatEvaluationSummary({ ...outcome,
      decision: { ...outcome.decision, verdict: 'PROGRESS' },
      gate: { gateStatus: 'blocked', reasonCodes: ['policy-blocked'] },
    }, 'en');
    expect(text).toContain('gate blocked');
    expect(text).toContain('gate conditions');
    expect(text).not.toContain('entering your release process');
  });

  it('shows a failed decision as missing verdict with its error code', () => {
    const text = formatEvaluationSummary({ ...outcome,
      decision: { decisionStatus: 'failed', errorCode: 'decision-source-unavailable' },
    }, 'zh');
    expect(text).toContain('评测结论：—');
    expect(text).toContain('decision-source-unavailable');
    expect(text).toContain('缺失证据');
  });

  it('preserves non-run outcomes instead of inventing a run verdict', () => {
    const series = { projectionKind: 'core-cli-series-outcome', runs: ['one', 'two'] };
    expect(JSON.parse(formatEvaluationSummary(series, 'zh'))).toEqual(series);
  });

  it('provides a localized executor-path remedy without leaking the command', () => {
    const error = new CliEvaluationInputError({
      code: 'CLI_INPUT_RESOLUTION_FAILED', fieldPath: 'targetRuntime.executorId',
      sourcePath: 'node script.mjs --token private-value', message: 'internal failure',
    });
    expect(formatEvaluationInputFailure(error, 'zh')).toContain('shebang');
    expect(formatEvaluationInputFailure(error, 'en')).toContain('one existing executable file');
    expect(formatEvaluationInputFailure(error, 'zh')).not.toContain('private-value');
    expect(formatEvaluationInputFailure(new Error('different failure'), 'en')).toBe('different failure');
  });
});
