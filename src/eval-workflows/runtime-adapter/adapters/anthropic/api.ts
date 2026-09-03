import { z } from 'zod';
import {
  RuntimeIdentitySchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type EvaluationDefinition,
  type JsonValue,
  type RuntimeIdentity,
  type RuntimeImplementationFacet,
} from '../../../../eval-core/contracts/index.js';
import {
  ExecutionPortFailure,
  type ExecutionExecutor,
  type ExecutorAttemptContext,
  type ExecutorAttemptResult,
} from '../../../../eval-core/execution/index.js';
import type { RuntimeBindingOf } from '../../types.js';
import type { OmkBindingResourceLeaseAccess } from '../../resource-leases/types.js';
import {
  captureClassifiedEnvironment,
  mergeOutputClassification,
} from '../shared/classified-environment.js';
import {
  ApiResponseBodyError,
  ApiResponseLimitError,
  captureCoreApiTransport,
  discardApiResponse,
  normalizeCoreApiEndpoint,
  readBoundedJsonResponse,
  requiredApiHeaderValue,
  type CapturedCoreApiTransport,
  type CoreApiTransport,
} from '../shared/api-http.js';
import {
  ANTHROPIC_API_CORE_ADAPTER_IMPLEMENTATION_VERSION,
  anthropicApiExecutorCapabilities,
  parseAnthropicApiMessage,
} from './protocol.js';
import {
  captureStatelessApiRunState,
  captureStatelessApiTarget,
  openStatelessApiTrial,
  type CapturedStatelessApiTarget,
  type StatelessApiRunState,
  type StatelessApiTrialState,
} from '../shared/stateless-api-resources.js';
import { createSameProcessExecutorAdapter } from '../shared/omk-resource-same-process.js';

export {
  ANTHROPIC_API_CORE_ADAPTER_IMPLEMENTATION_VERSION,
  createAnthropicApiCoreSchemaValidators,
} from './protocol.js';
export type {
  ApiTransportIdentity,
  CoreApiTransport,
  CoreApiTransportRequest,
} from '../shared/api-http.js';

export const DEFAULT_ANTHROPIC_API_ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_ANTHROPIC_API_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const DEFAULT_ANTHROPIC_API_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_ANTHROPIC_API_MAX_OUTPUT_TOKENS = 8192;
export const ANTHROPIC_API_VERSION = '2023-06-01';

const RESOURCE_PROFILE = Object.freeze({
  adapterLabel: 'Anthropic API',
  errorPrefix: 'OMK_ANTHROPIC_API',
  promptSchemaVersion: 'omk.anthropic-api-prompt/v1',
});

const AnthropicRequestPolicySchema = z.object({
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  stopSequences: z.array(z.string().min(1)).min(1).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'stopSequences must not contain duplicates.' });
    }
  }).optional(),
}).strict();

export interface AnthropicApiCoreConfiguration {
  /** Explicit credential. The adapter never reads process.env. */
  readonly apiKey: string;
  /** Complete Messages endpoint, not a mutable ambient base URL. */
  readonly endpoint?: string;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  /** Trusted host seam for offline conformance tests and custom transports. */
  readonly transport?: CoreApiTransport;
}

export interface CreateAnthropicApiExecutorAdapterInput {
  readonly target: EvaluationDefinition['targets'][number];
  readonly binding: RuntimeBindingOf<'executor'>;
  readonly api: AnthropicApiCoreConfiguration;
  readonly sessionIsolationKey: string;
  readonly resourceLeases: OmkBindingResourceLeaseAccess;
}

interface CapturedConfiguration {
  readonly apiKey: string;
  readonly endpoint: string;
  readonly environmentIdentity: JsonValue[];
  readonly environmentOutputClassification: 'public' | 'sensitive' | 'secret';
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly transport: CapturedCoreApiTransport;
}

interface AnthropicRequestPolicy {
  readonly maxOutputTokens: number;
  readonly stopSequences?: readonly string[];
}

function fail(
  code: string,
  stage: 'infrastructure' | 'execution',
  message: string,
): never {
  throw new ExecutionPortFailure({ code, stage, message });
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Anthropic API ${label} must be a positive safe integer.`);
  }
  return value;
}

function captureConfiguration(input: AnthropicApiCoreConfiguration): CapturedConfiguration {
  const apiKey = requiredApiHeaderValue(input.apiKey, 'Anthropic API apiKey');
  const endpoint = normalizeCoreApiEndpoint(
    input.endpoint ?? DEFAULT_ANTHROPIC_API_ENDPOINT,
    'Anthropic API endpoint',
  );
  const environment = captureClassifiedEnvironment({
    ANTHROPIC_API_KEY: {
      value: apiKey,
      identity: { identityKind: 'credential' },
    },
    ANTHROPIC_API_ENDPOINT: {
      value: endpoint,
      identity: { identityKind: 'effect-locator' },
    },
  });
  return Object.freeze({
    apiKey: environment.values.ANTHROPIC_API_KEY!,
    endpoint: environment.values.ANTHROPIC_API_ENDPOINT!,
    environmentIdentity: environment.identity,
    environmentOutputClassification: environment.outputClassification,
    maxRequestBytes: positiveSafeInteger(
      input.maxRequestBytes ?? DEFAULT_ANTHROPIC_API_MAX_REQUEST_BYTES,
      'maxRequestBytes',
    ),
    maxResponseBytes: positiveSafeInteger(
      input.maxResponseBytes ?? DEFAULT_ANTHROPIC_API_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
    ),
    transport: captureCoreApiTransport(input.transport),
  });
}

function captureRequestPolicy(target: CapturedStatelessApiTarget): AnthropicRequestPolicy {
  const parsed = AnthropicRequestPolicySchema.parse(
    target.config.behavior.config?.value ?? {},
  );
  return Object.freeze({
    maxOutputTokens: parsed.maxOutputTokens ?? DEFAULT_ANTHROPIC_API_MAX_OUTPUT_TOKENS,
    ...(parsed.stopSequences === undefined
      ? {}
      : { stopSequences: Object.freeze([...parsed.stopSequences]) }),
  });
}

function identityManifest(
  configuration: CapturedConfiguration,
  target: CapturedStatelessApiTarget,
  policy: AnthropicRequestPolicy,
): RuntimeIdentity['implementationManifest'] {
  const facets: RuntimeImplementationFacet[] = [{
    facetId: 'adapter.composition',
    value: {
      adapterVersion: ANTHROPIC_API_CORE_ADAPTER_IMPLEMENTATION_VERSION,
      cancellation: 'fetch-abort-signal',
      sourceProtocol: 'Anthropic Messages API',
    },
  }, {
    facetId: 'adapter.environment',
    value: { entries: [...configuration.environmentIdentity] },
  }, {
    facetId: 'adapter.input-projection',
    value: {
      directoryEntrypoint: 'SKILL.md',
      promptTransport: 'messages-user-text',
      supportingFiles: 'canonical-user-envelope',
      systemInstructions: 'top-level-system',
      version: RESOURCE_PROFILE.promptSchemaVersion,
    },
  }, {
    facetId: 'adapter.limits',
    value: {
      maxRequestBytes: configuration.maxRequestBytes,
      maxResponseBytes: configuration.maxResponseBytes,
    },
  }, {
    facetId: 'anthropic.request',
    value: {
      apiVersion: ANTHROPIC_API_VERSION,
      effort: target.binding.qualification.effort ?? null,
      maxOutputTokens: policy.maxOutputTokens,
      stopSequences: policy.stopSequences === undefined ? null : [...policy.stopSequences],
      streaming: false,
    },
  }, {
    facetId: 'runtime.binding',
    value: {
      behaviorConfigDigest: target.binding.behaviorConfigDigest,
      deploymentCoverage: 'remote-opaque',
      model: target.binding.qualification.model,
      protocolId: target.binding.protocolId,
      providerTransportRetries: configuration.transport.identity.retrySemantics,
      sandbox: 'none',
      skillDiscovery: 'none',
      toolPolicy: 'no-tools',
      workspace: 'none',
    },
  }, {
    facetId: 'transport.identity',
    value: configuration.transport.identity,
  }];
  return { coverageKind: 'fingerprint-plus-facets', facets };
}

function resolveIdentity(
  configuration: CapturedConfiguration,
  target: CapturedStatelessApiTarget,
  policy: AnthropicRequestPolicy,
): RuntimeIdentity {
  const capabilities = anthropicApiExecutorCapabilities();
  return deepFreezeCanonicalJson(RuntimeIdentitySchema.parse({
    implementationId: target.binding.implementationId,
    version: ANTHROPIC_API_CORE_ADAPTER_IMPLEMENTATION_VERSION,
    fingerprint: digestCanonicalJson({
      derivation: 'omk.anthropic-api-runtime-fingerprint/v1',
      adapterVersion: ANTHROPIC_API_CORE_ADAPTER_IMPLEMENTATION_VERSION,
      capabilities,
      environmentIdentity: configuration.environmentIdentity,
      limits: {
        maxRequestBytes: configuration.maxRequestBytes,
        maxResponseBytes: configuration.maxResponseBytes,
      },
      requestPolicy: {
        maxOutputTokens: policy.maxOutputTokens,
        ...(policy.stopSequences === undefined
          ? {}
          : { stopSequences: [...policy.stopSequences] }),
      },
      targetBindingDigest: digestCanonicalJson(target.binding),
      transportIdentity: configuration.transport.identity,
    }),
    fingerprintBasis: 'opaque',
    assuranceLevel: 'unknown',
    capabilities,
    implementationManifest: identityManifest(configuration, target, policy),
  }));
}

function requestBody(
  target: CapturedStatelessApiTarget,
  policy: AnthropicRequestPolicy,
  runState: StatelessApiRunState,
  trialState: StatelessApiTrialState,
): string {
  return JSON.stringify({
    model: target.binding.qualification.model,
    max_tokens: policy.maxOutputTokens,
    messages: [{ role: 'user', content: trialState.prompt }],
    stream: false,
    ...(runState.systemInstructions === undefined
      ? {}
      : { system: runState.systemInstructions }),
    ...(target.binding.qualification.effort === undefined
      ? {}
      : { output_config: { effort: target.binding.qualification.effort } }),
    ...(policy.stopSequences === undefined
      ? {}
      : { stop_sequences: policy.stopSequences }),
  });
}

async function executeAnthropic(
  configuration: CapturedConfiguration,
  target: CapturedStatelessApiTarget,
  policy: AnthropicRequestPolicy,
  runState: StatelessApiRunState,
  trialState: StatelessApiTrialState,
  attempt: Readonly<ExecutorAttemptContext>,
): Promise<ExecutorAttemptResult> {
  if (attempt.signal.aborted) {
    fail('OMK_ANTHROPIC_API_CANCELLED', 'execution', 'Anthropic API execution was cancelled.');
  }
  const body = requestBody(target, policy, runState, trialState);
  if (Buffer.byteLength(body) > configuration.maxRequestBytes) {
    fail(
      'OMK_ANTHROPIC_API_INPUT_LIMIT_EXCEEDED',
      'infrastructure',
      'Anthropic API request exceeded the adapter byte limit.',
    );
  }
  let response: Response;
  try {
    response = await configuration.transport.request({
      endpoint: configuration.endpoint,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-api-key': configuration.apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      body,
      signal: attempt.signal,
    });
  } catch {
    if (attempt.signal.aborted) {
      fail('OMK_ANTHROPIC_API_CANCELLED', 'execution', 'Anthropic API execution was cancelled.');
    }
    fail('transport-error', 'infrastructure', 'Anthropic API transport failed.');
  }
  if (!(response instanceof Response)) {
    fail('OMK_ANTHROPIC_API_TRANSPORT_INVALID', 'infrastructure', 'Anthropic API transport returned an invalid response.');
  }
  if (!response.ok) {
    await discardApiResponse(response);
    if (response.status === 429 || response.status >= 500) {
      fail('transport-error', 'infrastructure', 'Anthropic API transport is temporarily unavailable.');
    }
    if (response.status === 401 || response.status === 403) {
      fail('OMK_ANTHROPIC_API_AUTH_FAILED', 'execution', 'Anthropic API rejected the configured credential.');
    }
    fail('OMK_ANTHROPIC_API_REQUEST_REJECTED', 'execution', 'Anthropic API rejected the request.');
  }
  const contentType = response.headers.get('content-type')?.toLowerCase();
  if (contentType === undefined || !contentType.startsWith('application/json')) {
    await discardApiResponse(response);
    fail('OMK_ANTHROPIC_API_PROTOCOL_INVALID', 'execution', 'Anthropic API returned a non-JSON response.');
  }
  let value;
  try {
    value = await readBoundedJsonResponse(response, configuration.maxResponseBytes);
  } catch (error) {
    if (attempt.signal.aborted) {
      fail('OMK_ANTHROPIC_API_CANCELLED', 'execution', 'Anthropic API execution was cancelled.');
    }
    if (error instanceof ApiResponseLimitError) {
      fail(
        'OMK_ANTHROPIC_API_OUTPUT_LIMIT_EXCEEDED',
        'infrastructure',
        'Anthropic API response exceeded the adapter byte limit.',
      );
    }
    if (error instanceof ApiResponseBodyError) {
      fail('OMK_ANTHROPIC_API_PROTOCOL_INVALID', 'execution', 'Anthropic API returned invalid JSON.');
    }
    fail('transport-error', 'infrastructure', 'Anthropic API response transport failed.');
  }
  if (value === null) {
    fail('OMK_ANTHROPIC_API_PROTOCOL_INVALID', 'execution', 'Anthropic API returned an empty response.');
  }
  const parsed = parseAnthropicApiMessage(value);
  const classification = mergeOutputClassification(
    runState.classification,
    configuration.environmentOutputClassification,
  );
  return {
    output: {
      value: parsed.output,
      classification,
      mediaType: 'text/plain',
    },
    trace: {
      value: parsed.trace,
      classification,
      mediaType: 'application/vnd.omk.source-neutral-trace+json',
    },
    usage: parsed.usage,
  };
}

/** Creates a binding-local Anthropic Messages API Core Executor. */
export async function createAnthropicApiExecutorAdapter(
  input: Readonly<CreateAnthropicApiExecutorAdapterInput>,
): Promise<ExecutionExecutor> {
  if (typeof input.sessionIsolationKey !== 'string' || input.sessionIsolationKey.trim() === '') {
    throw new TypeError('Anthropic API adapter requires a non-empty sessionIsolationKey.');
  }
  const target = captureStatelessApiTarget(input.target, input.binding, RESOURCE_PROFILE);
  const configuration = captureConfiguration(input.api);
  const policy = captureRequestPolicy(target);
  const identity = resolveIdentity(configuration, target, policy);
  const resourceLeases = Object.freeze({
    forRun: input.resourceLeases.forRun.bind(input.resourceLeases),
  });
  return createSameProcessExecutorAdapter({
    identity,
    sessionIsolationKey: input.sessionIsolationKey,
    resourceLeases,
    implementation: {
      openRun({ resources }) {
        return captureStatelessApiRunState(
          resources,
          target,
          configuration.maxRequestBytes,
          RESOURCE_PROFILE,
        );
      },
      openTrial({ trial, runState }) {
        if (
          trial.protocolId !== target.binding.protocolId
          || trial.targetId !== target.binding.targetId
          || canonicalizeJson(trial.targetConfig ?? null)
            !== canonicalizeJson(target.target.config ?? null)
        ) {
          fail(
            'OMK_ANTHROPIC_API_TRIAL_MISMATCH',
            'infrastructure',
            'Anthropic API trial does not match the sealed Target binding.',
          );
        }
        return openStatelessApiTrial(
          trial,
          runState,
          configuration.maxRequestBytes,
          RESOURCE_PROFILE,
        );
      },
      execute({ runState, trialState, attempt }) {
        return executeAnthropic(
          configuration,
          target,
          policy,
          runState,
          trialState,
          attempt,
        );
      },
      disposeTrial() {},
      disposeRun() {},
    },
  });
}
