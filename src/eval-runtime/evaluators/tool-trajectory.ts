import {
  type JsonValue,
  type RuntimeIdentity,
} from '../../eval-core/contracts/index.js';
import type {
  EvaluationEvaluator,
  EvaluatorBindingValue,
  EvaluatorObservation,
} from '../../eval-core/evaluation/index.js';
import { createSameProcessEvaluatorAdapter } from '../adapters/same-process.js';
import { createRuntimeIdentity } from '../identity.js';
import {
  SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
  SourceNeutralTraceSchema,
} from '../traces/source-neutral.js';

export const TOOL_TRAJECTORY_EVALUATOR_IMPLEMENTATION_ID =
  'omk.eval-runtime.tool-trajectory/v1' as const;

export type ToolTrajectoryMatchMode =
  | 'exact-order'
  | 'same-tools'
  | 'contains-in-order'
  | 'contains-any-order';

export interface CreateToolTrajectoryEvaluatorInput {
  readonly evaluatorId: string;
  readonly metricId: string;
  readonly tracePointer: string;
  readonly expectedToolNamesPointer: string;
  readonly match: ToolTrajectoryMatchMode;
  readonly traceBindingId?: string;
  readonly expectedToolNamesBindingId?: string;
  readonly sessionIsolationKey?: string;
}

const MATCH_MODES = new Set<ToolTrajectoryMatchMode>([
  'exact-order',
  'same-tools',
  'contains-in-order',
  'contains-any-order',
]);

function binding(
  bindings: readonly EvaluatorBindingValue[],
  bindingId: string,
): EvaluatorBindingValue | undefined {
  return bindings.find((entry) => entry.bindingId === bindingId);
}

function toolNames(value: JsonValue): string[] | undefined {
  if (!Array.isArray(value)
      || Object.keys(value).length !== value.length
      || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    return undefined;
  }
  return value as string[];
}

function assertToolNames(name: string, values: readonly string[]): void {
  if (!Array.isArray(values)
      || Object.keys(values).length !== values.length
      || values.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new TypeError(`${name} must be a dense array of non-empty tool names.`);
  }
}

function counts(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

export function matchesToolTrajectory(input: Readonly<{
  actualToolNames: readonly string[];
  expectedToolNames: readonly string[];
  match: ToolTrajectoryMatchMode;
}>): boolean {
  assertToolNames('actualToolNames', input.actualToolNames);
  assertToolNames('expectedToolNames', input.expectedToolNames);
  if (!MATCH_MODES.has(input.match)) throw new TypeError('Unsupported tool trajectory match mode.');
  if (input.expectedToolNames.length === 0
      && (input.match === 'contains-in-order' || input.match === 'contains-any-order')) {
    throw new TypeError('A contains match requires at least one expected tool name.');
  }
  if (input.match === 'exact-order') {
    return input.actualToolNames.length === input.expectedToolNames.length
      && input.actualToolNames.every((name, index) => name === input.expectedToolNames[index]);
  }
  const actualCounts = counts(input.actualToolNames);
  const expectedCounts = counts(input.expectedToolNames);
  if (input.match === 'same-tools') {
    return actualCounts.size === expectedCounts.size
      && [...expectedCounts].every(([name, count]) => actualCounts.get(name) === count);
  }
  if (input.match === 'contains-any-order') {
    return [...expectedCounts].every(([name, count]) => (actualCounts.get(name) ?? 0) >= count);
  }
  let expectedIndex = 0;
  for (const name of input.actualToolNames) {
    if (name === input.expectedToolNames[expectedIndex]) expectedIndex += 1;
  }
  return expectedIndex === input.expectedToolNames.length;
}

function observation(
  metricId: string,
  value: Readonly<
    | { observationStatus: 'observed'; matched: boolean }
    | { observationStatus: 'missing' | 'invalid'; reasonCode: string }
  >,
): EvaluatorObservation {
  if (value.observationStatus === 'observed') {
    return {
      metricId,
      observationStatus: 'observed',
      valueType: 'boolean',
      value: value.matched,
    };
  }
  return {
    metricId,
    observationStatus: value.observationStatus,
    valueType: 'boolean',
    reasonCode: value.reasonCode,
  };
}

export function createToolTrajectoryEvaluatorIdentity(
  input: Readonly<CreateToolTrajectoryEvaluatorInput>,
): RuntimeIdentity {
  return createRuntimeIdentity({
    implementationId: TOOL_TRAJECTORY_EVALUATOR_IMPLEMENTATION_ID,
    version: '1.0.0',
    capabilities: {
      inputSourceKinds: ['expected', 'trace'],
      metricValueTypes: ['boolean'],
      schemas: [],
    },
    fingerprintFacets: {
      algorithm: 'source-neutral-tool-name-trajectory/v1',
      evaluatorId: input.evaluatorId,
      metricId: input.metricId,
      tracePointer: input.tracePointer,
      expectedToolNamesPointer: input.expectedToolNamesPointer,
      match: input.match,
      traceSchemaVersion: SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
      toolIdentityComparison: 'case-sensitive',
      toolCallCollection: 'top-level-toolCalls',
      toolCallOrder: 'array-order',
      toolCallSelection: 'all-statuses',
      traceRoleSelection: 'all',
      multiplicity: 'preserved',
    },
  });
}

/** Creates the deterministic source-neutral tool trajectory Evaluator. */
export function createToolTrajectoryEvaluator(
  input: Readonly<CreateToolTrajectoryEvaluatorInput>,
): EvaluationEvaluator {
  const traceBindingId = input.traceBindingId ?? 'trace';
  const expectedBindingId = input.expectedToolNamesBindingId ?? 'expected-tool-names';
  const identity = createToolTrajectoryEvaluatorIdentity(input);
  return createSameProcessEvaluatorAdapter({
    identity,
    sessionIsolationKey: input.sessionIsolationKey
      ?? `omk.eval-runtime.tool-trajectory/v1:${identity.fingerprint}`,
    resourceLeases: { forRun: () => undefined },
    implementation: {
      openRun: () => undefined,
      openRecord: () => undefined,
      evaluate({ record, attempt }) {
        if (attempt.signal.aborted) return Promise.reject(attempt.signal.reason);
        const traceBinding = binding(record.bindings, traceBindingId);
        const expectedBinding = binding(record.bindings, expectedBindingId);
        if (traceBinding === undefined || expectedBinding === undefined) {
          return Promise.resolve({
            observations: [observation(input.metricId, {
              observationStatus: 'missing',
              reasonCode: traceBinding === undefined
                ? 'tool-trajectory-trace-missing'
                : 'tool-trajectory-expected-missing',
            })],
          });
        }
        const trace = SourceNeutralTraceSchema.safeParse(traceBinding.value);
        if (!trace.success) {
          return Promise.resolve({
            observations: [observation(input.metricId, {
              observationStatus: 'invalid',
              reasonCode: 'tool-trajectory-trace-invalid',
            })],
          });
        }
        const expected = toolNames(expectedBinding.value);
        if (expected === undefined) {
          return Promise.resolve({
            observations: [observation(input.metricId, {
              observationStatus: 'invalid',
              reasonCode: 'tool-trajectory-expected-invalid',
            })],
          });
        }
        if (expected.length === 0
            && (input.match === 'contains-in-order' || input.match === 'contains-any-order')) {
          return Promise.resolve({
            observations: [observation(input.metricId, {
              observationStatus: 'invalid',
              reasonCode: 'tool-trajectory-expected-empty',
            })],
          });
        }
        const actual = trace.data.toolCalls.map((call) => (
          (call as Readonly<{ tool: string }>).tool
        ));
        return Promise.resolve({
          observations: [observation(input.metricId, {
            observationStatus: 'observed',
            matched: matchesToolTrajectory({
              actualToolNames: actual,
              expectedToolNames: expected,
              match: input.match,
            }),
          })],
        });
      },
      disposeRecord: () => undefined,
      disposeRun: () => undefined,
    },
  });
}
