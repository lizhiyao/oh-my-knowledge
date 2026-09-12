import { describe, expect, it } from 'vitest';
import {
  EvaluationConfigurationError,
} from '../../src/eval-runtime/evaluation/errors.js';
import {
  describeStageFailure,
  StageInvariantViolation,
} from '../../src/eval-runtime/evaluation/stage-session.js';
import {
  ExecutionRuntimeConfigurationError,
} from '../../src/eval-core/execution/types.js';
import {
  EvaluationRuntimeConfigurationError,
} from '../../src/eval-core/evaluation/types.js';
import {
  AnalysisRuntimeConfigurationError,
} from '../../src/eval-core/analysis/types.js';
import {
  EvaluationStageSessionError,
} from '../../src/eval-core/engine/index.js';

const WRITER_REQUIRED = 'Required EventWriter mode needs an injected EventWriter.';

const describeReuseFailure = (failure: unknown) => describeStageFailure(
  failure,
  'Evaluation stage reuse',
);

const coreConfigurationFailures = [
  new ExecutionRuntimeConfigurationError(
    'EXECUTION_RUNTIME_EVENT_WRITER_REQUIRED',
    WRITER_REQUIRED,
  ),
  new EvaluationRuntimeConfigurationError(
    'EVALUATION_RUNTIME_EVENT_WRITER_REQUIRED',
    WRITER_REQUIRED,
  ),
  new AnalysisRuntimeConfigurationError(
    'ANALYSIS_RUNTIME_EVENT_WRITER_REQUIRED',
    WRITER_REQUIRED,
  ),
  new EvaluationStageSessionError(
    'EVALUATION_STAGE_SESSION_EVENT_BUFFER_CAPACITY_INVALID',
    'Event buffer capacity is invalid.',
  ),
];

describe('reuse boundary failure origin', () => {
  it('keeps every Core configuration failure on one sentence with its own code', () => {
    const reports = coreConfigurationFailures.map((failure) => describeReuseFailure(failure));
    expect(reports.map((report) => report.origin)).toEqual([
      { failureKind: 'configuration', code: 'EXECUTION_RUNTIME_EVENT_WRITER_REQUIRED' },
      { failureKind: 'configuration', code: 'EVALUATION_RUNTIME_EVENT_WRITER_REQUIRED' },
      { failureKind: 'configuration', code: 'ANALYSIS_RUNTIME_EVENT_WRITER_REQUIRED' },
      {
        failureKind: 'configuration',
        code: 'EVALUATION_STAGE_SESSION_EVENT_BUFFER_CAPACITY_INVALID',
      },
    ]);
    expect(new Set(reports.map((report) => report.message)).size).toBe(1);
  });

  it('separates an internal invariant from a host configuration failure and an unknown failure', () => {
    const invariant = describeReuseFailure(
      new StageInvariantViolation('Evaluation stage source is unavailable.'),
    );
    const sessionMisuse = describeReuseFailure(
      new EvaluationStageSessionError(
        'EVALUATION_STAGE_SESSION_BUSY',
        'A stage is already running.',
      ),
    );
    const configuration = describeReuseFailure(coreConfigurationFailures[1]);
    const unknown = describeReuseFailure(new Error('host audit sink unavailable'));

    expect(invariant.origin).toEqual({ failureKind: 'invariant' });
    expect(sessionMisuse).toEqual(invariant);
    expect(unknown.origin).toEqual({ failureKind: 'unknown' });
    expect(new Set([invariant.message, configuration.message, unknown.message]).size).toBe(3);
  });

  it('passes through only a stable code shape and never any wrapped error text', () => {
    const spoofedCode = describeReuseFailure(
      new EvaluationRuntimeConfigurationError('tenant prompt text', 'sample gold answer'),
    );
    expect(spoofedCode.origin).toEqual({ failureKind: 'configuration' });

    const hostError = Object.assign(
      new Error('sample gold answer'),
      { code: 'sample gold answer' },
    );
    expect(describeReuseFailure(hostError).origin).toEqual({ failureKind: 'unknown' });

    const error = new EvaluationConfigurationError(
      'EVAL_RUNTIME_REUSE_INVALID',
      spoofedCode.message,
      spoofedCode.origin,
    );
    expect(error.cause).toEqual({ failureKind: 'configuration' });
    expect(JSON.stringify(error)).not.toMatch(/sample gold answer|tenant prompt text/);
    expect(Object.keys(error)).not.toContain('cause');
    expect(error.stack).not.toContain('sample gold answer');
  });

  it('keeps the reporting boundary in every message while the origin stays shared', () => {
    const failure = new StageInvariantViolation('Evaluation stage source is unavailable.');
    const reuse = describeReuseFailure(failure);
    const scoring = describeStageFailure(failure, 'Evaluation stage scoring');

    expect(scoring.origin).toEqual(reuse.origin);
    expect(scoring.message).not.toBe(reuse.message);
    for (const boundary of ['Evaluation stage reuse', 'Evaluation stage scoring'] as const) {
      for (const candidate of [failure, new Error('host sink unavailable')]) {
        expect(
          describeStageFailure(candidate, boundary).message.startsWith(`${boundary} `),
        ).toBe(true);
      }
    }
  });
});
