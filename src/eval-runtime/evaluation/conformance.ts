import {
  type JsonValue,
  IdentifierSchema,
  deepFreezeCanonicalJson,
} from '../../eval-core/contracts/index.js';
import {
  type ExecutorCheckInput,
  type ExecutorCheckResult,
} from './contracts.js';
import {
  configurationFailure,
} from './errors.js';
import {
  captureVariant,
  parseWithoutTransform,
} from './capture-input.js';
import {
  runExecutorConformance,
} from '../conformance/executor.js';
import {
  type ContentStoreCheckInput,
  type ContentStoreCheckResult,
  runContentStoreConformance,
} from '../conformance/content-store.js';
import {
  captureEvaluationInfrastructure,
  type ContentValue,
} from '../infrastructure.js';
import {
  ContentValueSchema,
} from './schemas.js';

/** Exercises one Executor through success, failure, cancellation, cleanup, and measurement checks. */
export async function checkExecutor<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
>(
  input: Readonly<ExecutorCheckInput<Input, Config, Output, Trace>>,
): Promise<ExecutorCheckResult> {
  if (input === null || typeof input !== 'object') {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Executor check input 无效。',
    );
  }
  if (input.success === null || typeof input.success !== 'object'
      || input.failure === null || typeof input.failure !== 'object'
      || input.cancellation === null || typeof input.cancellation !== 'object'
      || (input.seed !== undefined && (typeof input.seed !== 'string' || input.seed.length === 0))
      || (input.runId !== undefined && !IdentifierSchema.safeParse(input.runId).success)) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Executor check probe declaration 无效。',
    );
  }
  if (input.variant?.execution?.workspace !== undefined
      || input.variant?.execution?.executor?.workspaceProvider !== undefined
      || input.variant?.execution?.allowedTools !== undefined
      || input.variant?.execution?.executor?.capabilities?.toolPolicy !== undefined
      || input.variant?.execution?.mcpConfig !== undefined
      || input.variant?.execution?.executor?.mcpConfigProvider !== undefined
      || input.variant?.execution?.executor?.capabilities?.mcp !== undefined
      || input.variant?.execution?.mockInterception !== undefined
      || input.variant?.execution?.executor?.mockInterceptionProvider !== undefined
      || input.variant?.execution?.executor?.capabilities?.mockInterception !== undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Executor check 暂不认证 workspaceProvider、toolPolicy、mcpConfigProvider 或 mockInterceptionProvider；请使用真实 Evaluation 验证受控资源与工具调用拦截。',
    );
  }
  const variant = captureVariant(input.variant, new Set());
  const executor = variant.executor;
  const successInput = parseWithoutTransform(
    executor.inputParser,
    input.success.input,
    'EVAL_RUNTIME_INPUT_INVALID',
    'Executor check success input 不符合 input schema，或 schema 改变了值。',
  );
  const successExpected = parseWithoutTransform(
    executor.outputParser,
    input.success.expected,
    'EVAL_RUNTIME_INPUT_INVALID',
    'Executor check expected output 不符合 output schema，或 schema 改变了值。',
  );
  const failureInput = parseWithoutTransform(
    executor.inputParser,
    input.failure.input,
    'EVAL_RUNTIME_INPUT_INVALID',
    'Executor check failure input 不符合 input schema，或 schema 改变了值。',
  );
  const cancellationInput = parseWithoutTransform(
    executor.inputParser,
    input.cancellation.input,
    'EVAL_RUNTIME_INPUT_INVALID',
    'Executor check cancellation input 不符合 input schema，或 schema 改变了值。',
  );
  if (!IdentifierSchema.safeParse(input.failure.expectedErrorCode).success) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Executor check expectedErrorCode 无效。',
    );
  }
  return runExecutorConformance({
    implementationId: executor.declaration.executorId,
    protocolId: executor.protocolId,
    createExecutor() {
      return executor.createPort(variant.variantId);
    },
    success: {
      input: successInput,
      expected: successExpected,
      targetConfig: variant.envelope,
    },
    failure: {
      input: failureInput,
      expectedErrorCode: input.failure.expectedErrorCode,
      targetConfig: variant.envelope,
    },
    cancellation: {
      input: cancellationInput,
      targetConfig: variant.envelope,
    },
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
  });
}

/** Checks one host ContentStore／ContentResolver pair through an idempotent round trip. */
export async function checkContentStore(
  input: Readonly<ContentStoreCheckInput>,
): Promise<ContentStoreCheckResult> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => ![
        'contentStore',
        'contentResolver',
        'probe',
        'timeoutMs',
      ].includes(key))) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'ContentStore check input 无效。',
    );
  }
  const timeoutMs = input.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'ContentStore check timeoutMs 必须是 1 到 60000 之间的整数。',
    );
  }
  const declaredContentStore = input.contentStore;
  const declaredContentResolver = input.contentResolver;
  let capturedInfrastructure: ReturnType<typeof captureEvaluationInfrastructure>;
  let probe: ContentValue;
  try {
    capturedInfrastructure = captureEvaluationInfrastructure({
      contentStore: declaredContentStore,
      contentResolver: declaredContentResolver,
    });
    probe = deepFreezeCanonicalJson(ContentValueSchema.parse(structuredClone(
      input.probe ?? {
        value: { conformance: 'omk-content-store/v1' },
        classification: 'public',
        mediaType: 'application/json',
      },
    ))) as ContentValue;
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'ContentStore check declaration 无效。',
    );
  }
  const support = capturedInfrastructure?.support;
  if (support?.executionContentStore === undefined || support.contentResolver === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'ContentStore check 需要 contentStore 与 contentResolver。',
    );
  }
  return runContentStoreConformance({
    contentStore: support.executionContentStore,
    contentResolver: support.contentResolver,
    probe,
    timeoutMs,
  });
}
