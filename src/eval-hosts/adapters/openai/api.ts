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
} from '../../../eval-core/contracts/index.js';
import {
  ExecutionPortFailure,
  type ExecutionExecutor,
  type ExecutorAttemptContext,
  type ExecutorAttemptResult,
} from '../../../eval-core/execution/index.js';
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
  OPENAI_API_CORE_ADAPTER_IMPLEMENTATION_VERSION,
  openAIApiExecutorCapabilities,
  parseOpenAIApiResponse,
} from './protocol.js';
import {
  captureStatelessApiRunState,
  captureStatelessApiTarget,
  openStatelessApiTrial,
  type CapturedStatelessApiTarget,
  type StatelessApiRunState,
  type StatelessApiTrialState,
} from '../shared/stateless-api-resources.js';
import { createSameProcessExecutorAdapter } from '../../../eval-runtime/adapters/same-process.js';

export {
  OPENAI_API_CORE_ADAPTER_IMPLEMENTATION_VERSION,
  createOpenAIApiCoreSchemaValidators,
} from './protocol.js';

export const DEFAULT_OPENAI_API_ENDPOINT = 'https://api.openai.com/v1/responses';
export const DEFAULT_OPENAI_API_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const DEFAULT_OPENAI_API_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_OPENAI_API_MAX_OUTPUT_TOKENS = 8192;

const RESOURCE_PROFILE = Object.freeze({
  adapterLabel: 'OpenAI API',
  errorPrefix: 'OMK_OPENAI_API',
  promptSchemaVersion: 'omk.openai-api-prompt/v1',
});

const OpenAIRequestPolicySchema = z.object({
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

export interface OpenAIApiCoreConfiguration {
  /** Explicit credential. The adapter never reads process.env. */
  readonly apiKey: string;
  /** Complete Responses endpoint, not a mutable ambient base URL. */
  readonly endpoint?: string;
  readonly organization?: string;
  readonly project?: string;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  /** Trusted host seam for offline conformance tests and custom transports. */
  readonly transport?: CoreApiTransport;
}

export interface CreateOpenAIApiExecutorAdapterInput {
  readonly target: EvaluationDefinition['targets'][number];
  readonly binding: RuntimeBindingOf<'executor'>;
  readonly api: OpenAIApiCoreConfiguration;
  readonly sessionIsolationKey: string;
  readonly resourceLeases: OmkBindingResourceLeaseAccess;
}

interface CapturedConfiguration {
  readonly apiKey: string;
  readonly endpoint: string;
  readonly organization?: string;
  readonly project?: string;
  readonly environmentIdentity: JsonValue[];
  readonly environmentOutputClassification: 'public' | 'sensitive' | 'secret';
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly transport: CapturedCoreApiTransport;
}

interface OpenAIRequestPolicy {
  readonly maxOutputTokens: number;
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
    throw new TypeError(`OpenAI API ${label} must be a positive safe integer.`);
  }
  return value;
}

function captureConfiguration(input: OpenAIApiCoreConfiguration): CapturedConfiguration {
  const apiKey = requiredApiHeaderValue(input.apiKey, 'OpenAI API apiKey');
  const endpoint = normalizeCoreApiEndpoint(
    input.endpoint ?? DEFAULT_OPENAI_API_ENDPOINT,
    'OpenAI API endpoint',
  );
  const organization = input.organization === undefined
    ? undefined
    : requiredApiHeaderValue(input.organization, 'OpenAI API organization');
  const project = input.project === undefined
    ? undefined
    : requiredApiHeaderValue(input.project, 'OpenAI API project');
  const environment = captureClassifiedEnvironment({
    OPENAI_API_KEY: { value: apiKey, identity: { identityKind: 'credential' } },
    OPENAI_API_ENDPOINT: { value: endpoint, identity: { identityKind: 'effect-locator' } },
    ...(organization === undefined ? {} : {
      OPENAI_ORGANIZATION: {
        value: organization,
        identity: { identityKind: 'effect-locator' as const },
      },
    }),
    ...(project === undefined ? {} : {
      OPENAI_PROJECT: {
        value: project,
        identity: { identityKind: 'effect-locator' as const },
      },
    }),
  });
  return Object.freeze({
    apiKey: environment.values.OPENAI_API_KEY!,
    endpoint: environment.values.OPENAI_API_ENDPOINT!,
    ...(organization === undefined ? {} : { organization: environment.values.OPENAI_ORGANIZATION! }),
    ...(project === undefined ? {} : { project: environment.values.OPENAI_PROJECT! }),
    environmentIdentity: environment.identity,
    environmentOutputClassification: environment.outputClassification,
    maxRequestBytes: positiveSafeInteger(
      input.maxRequestBytes ?? DEFAULT_OPENAI_API_MAX_REQUEST_BYTES,
      'maxRequestBytes',
    ),
    maxResponseBytes: positiveSafeInteger(
      input.maxResponseBytes ?? DEFAULT_OPENAI_API_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
    ),
    transport: captureCoreApiTransport(input.transport),
  });
}

function captureRequestPolicy(target: CapturedStatelessApiTarget): OpenAIRequestPolicy {
  const parsed = OpenAIRequestPolicySchema.parse(target.config.behavior.config?.value ?? {});
  return Object.freeze({
    maxOutputTokens: parsed.maxOutputTokens ?? DEFAULT_OPENAI_API_MAX_OUTPUT_TOKENS,
  });
}

function identityManifest(
  configuration: CapturedConfiguration,
  target: CapturedStatelessApiTarget,
  policy: OpenAIRequestPolicy,
): RuntimeIdentity['implementationManifest'] {
  const facets: RuntimeImplementationFacet[] = [{
    facetId: 'adapter.composition',
    value: {
      adapterVersion: OPENAI_API_CORE_ADAPTER_IMPLEMENTATION_VERSION,
      cancellation: 'fetch-abort-signal',
      sourceProtocol: 'OpenAI Responses API',
    },
  }, {
    facetId: 'adapter.environment',
    value: { entries: [...configuration.environmentIdentity] },
  }, {
    facetId: 'adapter.input-projection',
    value: {
      directoryEntrypoint: 'SKILL.md',
      promptTransport: 'responses-input-text',
      supportingFiles: 'canonical-user-envelope',
      systemInstructions: 'top-level-instructions',
      version: RESOURCE_PROFILE.promptSchemaVersion,
    },
  }, {
    facetId: 'adapter.limits',
    value: {
      maxRequestBytes: configuration.maxRequestBytes,
      maxResponseBytes: configuration.maxResponseBytes,
    },
  }, {
    facetId: 'openai.request',
    value: {
      background: false,
      effort: target.binding.qualification.effort ?? null,
      maxOutputTokens: policy.maxOutputTokens,
      parallelToolCalls: false,
      store: false,
      streaming: false,
      toolChoice: 'none',
      tools: 'none',
      truncation: 'disabled',
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
  policy: OpenAIRequestPolicy,
): RuntimeIdentity {
  const capabilities = openAIApiExecutorCapabilities();
  return deepFreezeCanonicalJson(RuntimeIdentitySchema.parse({
    implementationId: target.binding.implementationId,
    version: OPENAI_API_CORE_ADAPTER_IMPLEMENTATION_VERSION,
    fingerprint: digestCanonicalJson({
      derivation: 'omk.openai-api-runtime-fingerprint/v1',
      adapterVersion: OPENAI_API_CORE_ADAPTER_IMPLEMENTATION_VERSION,
      capabilities,
      environmentIdentity: configuration.environmentIdentity,
      limits: {
        maxRequestBytes: configuration.maxRequestBytes,
        maxResponseBytes: configuration.maxResponseBytes,
      },
      requestPolicy: { maxOutputTokens: policy.maxOutputTokens },
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
  policy: OpenAIRequestPolicy,
  runState: StatelessApiRunState,
  trialState: StatelessApiTrialState,
): string {
  return JSON.stringify({
    model: target.binding.qualification.model,
    input: trialState.prompt,
    ...(runState.systemInstructions === undefined
      ? {}
      : { instructions: runState.systemInstructions }),
    max_output_tokens: policy.maxOutputTokens,
    stream: false,
    store: false,
    background: false,
    tools: [],
    tool_choice: 'none',
    parallel_tool_calls: false,
    truncation: 'disabled',
    ...(target.binding.qualification.effort === undefined
      ? {}
      : { reasoning: { effort: target.binding.qualification.effort } }),
  });
}

async function executeOpenAI(
  configuration: CapturedConfiguration,
  target: CapturedStatelessApiTarget,
  policy: OpenAIRequestPolicy,
  runState: StatelessApiRunState,
  trialState: StatelessApiTrialState,
  attempt: Readonly<ExecutorAttemptContext>,
): Promise<ExecutorAttemptResult> {
  if (attempt.signal.aborted) {
    fail('OMK_OPENAI_API_CANCELLED', 'execution', 'OpenAI API execution was cancelled.');
  }
  const body = requestBody(target, policy, runState, trialState);
  if (Buffer.byteLength(body) > configuration.maxRequestBytes) {
    fail(
      'OMK_OPENAI_API_INPUT_LIMIT_EXCEEDED',
      'infrastructure',
      'OpenAI API request exceeded the adapter byte limit.',
    );
  }
  let response: Response;
  try {
    response = await configuration.transport.request({
      endpoint: configuration.endpoint,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${configuration.apiKey}`,
        'content-type': 'application/json',
        ...(configuration.organization === undefined
          ? {}
          : { 'openai-organization': configuration.organization }),
        ...(configuration.project === undefined
          ? {}
          : { 'openai-project': configuration.project }),
      },
      body,
      signal: attempt.signal,
    });
  } catch {
    if (attempt.signal.aborted) {
      fail('OMK_OPENAI_API_CANCELLED', 'execution', 'OpenAI API execution was cancelled.');
    }
    fail('transport-error', 'infrastructure', 'OpenAI API transport failed.');
  }
  if (!(response instanceof Response)) {
    fail('OMK_OPENAI_API_TRANSPORT_INVALID', 'infrastructure', 'OpenAI API transport returned an invalid response.');
  }
  if (!response.ok) {
    await discardApiResponse(response);
    if (response.status === 429 || response.status >= 500) {
      fail('transport-error', 'infrastructure', 'OpenAI API transport is temporarily unavailable.');
    }
    if (response.status === 401 || response.status === 403) {
      fail('OMK_OPENAI_API_AUTH_FAILED', 'execution', 'OpenAI API rejected the configured credential.');
    }
    fail('OMK_OPENAI_API_REQUEST_REJECTED', 'execution', 'OpenAI API rejected the request.');
  }
  const contentType = response.headers.get('content-type')?.toLowerCase();
  if (contentType === undefined || !contentType.startsWith('application/json')) {
    await discardApiResponse(response);
    fail('OMK_OPENAI_API_PROTOCOL_INVALID', 'execution', 'OpenAI API returned a non-JSON response.');
  }
  let value;
  try {
    value = await readBoundedJsonResponse(response, configuration.maxResponseBytes);
  } catch (error) {
    if (attempt.signal.aborted) {
      fail('OMK_OPENAI_API_CANCELLED', 'execution', 'OpenAI API execution was cancelled.');
    }
    if (error instanceof ApiResponseLimitError) {
      fail(
        'OMK_OPENAI_API_OUTPUT_LIMIT_EXCEEDED',
        'infrastructure',
        'OpenAI API response exceeded the adapter byte limit.',
      );
    }
    if (error instanceof ApiResponseBodyError) {
      fail('OMK_OPENAI_API_PROTOCOL_INVALID', 'execution', 'OpenAI API returned invalid JSON.');
    }
    fail('transport-error', 'infrastructure', 'OpenAI API response transport failed.');
  }
  if (value === null) {
    fail('OMK_OPENAI_API_PROTOCOL_INVALID', 'execution', 'OpenAI API returned an empty response.');
  }
  const parsed = parseOpenAIApiResponse(value, target.binding.qualification.effort);
  const classification = mergeOutputClassification(
    runState.classification,
    configuration.environmentOutputClassification,
  );
  return {
    output: { value: parsed.output, classification, mediaType: 'text/plain' },
    trace: {
      value: parsed.trace,
      classification,
      mediaType: 'application/vnd.omk.source-neutral-trace+json',
    },
    usage: parsed.usage,
  };
}

/** Creates a binding-local OpenAI Responses API Core Executor. */
export async function createOpenAIApiExecutorAdapter(
  input: Readonly<CreateOpenAIApiExecutorAdapterInput>,
): Promise<ExecutionExecutor> {
  if (typeof input.sessionIsolationKey !== 'string' || input.sessionIsolationKey.trim() === '') {
    throw new TypeError('OpenAI API adapter requires a non-empty sessionIsolationKey.');
  }
  const target = captureStatelessApiTarget(input.target, input.binding, RESOURCE_PROFILE);
  const configuration = captureConfiguration(input.api);
  const policy = captureRequestPolicy(target);
  const identity = resolveIdentity(configuration, target, policy);
  const resourceLeases = Object.freeze({ forRun: input.resourceLeases.forRun.bind(input.resourceLeases) });
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
            'OMK_OPENAI_API_TRIAL_MISMATCH',
            'infrastructure',
            'OpenAI API trial does not match the sealed Target binding.',
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
        return executeOpenAI(configuration, target, policy, runState, trialState, attempt);
      },
      disposeTrial() {},
      disposeRun() {},
    },
  });
}
