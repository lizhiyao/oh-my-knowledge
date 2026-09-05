import type {
  ContentDescriptor as CoreContentDescriptor,
  JsonValue,
  RuntimeIdentity,
  Sha256Digest,
} from '../eval-core/contracts/index.js';
import {
  IdentifierSchema,
  RuntimeIdentitySchema,
  deepFreezeCanonicalJson,
} from '../eval-core/contracts/index.js';
import type {
  ExecutionCache as CoreExecutionCache,
  ExecutionCacheEntry as CoreExecutionCacheEntry,
  ExecutionContentStoreRequest,
} from '../eval-core/execution/index.js';
import type {
  EvaluationCache as CoreEvaluationCache,
  EvaluationCacheEntry as CoreEvaluationCacheEntry,
  EvaluationContent,
  EvaluationContentResolver,
} from '../eval-core/evaluation/index.js';
import type { EvaluationExecutor } from './evaluate.js';
import type { EvaluationRuntimeSupportPorts } from './runtime.js';

export type ContentDescriptor = CoreContentDescriptor;
export type ContentValue = EvaluationContent;
export type ContentStoreRequest = ExecutionContentStoreRequest;
export type ExecutionCache = CoreExecutionCache;
export type ExecutionCacheEntry = CoreExecutionCacheEntry;
export type EvaluationCache = CoreEvaluationCache;
export type EvaluationCacheEntry = CoreEvaluationCacheEntry;

export interface ExecutorIdentityVerificationRequest {
  /** Captured Executor declaration whose exact callable implementation must be verified. */
  readonly executor: EvaluationExecutor<JsonValue, JsonValue | undefined, JsonValue, JsonValue>;
  readonly declaredIdentity: RuntimeIdentity;
}

export interface ExecutorIdentityVerification {
  /** Stable digest issued by an independent verifier for this exact implementation identity. */
  readonly attestationDigest: Sha256Digest;
}

export interface ExecutorIdentityVerifier {
  readonly verifierId: string;
  verify(
    request: Readonly<ExecutorIdentityVerificationRequest>,
  ): Promise<ExecutorIdentityVerification>;
}

export interface ContentStore {
  /** Optional descriptor URIs are persisted; return only stable, opaque, credential-free locators. */
  put(request: Readonly<ContentStoreRequest>): Promise<ContentDescriptor>;
}

export interface ContentResolver {
  resolve(descriptor: Readonly<ContentDescriptor>): Promise<ContentValue>;
}

/** Host-owned ports. Implementations and credentials remain outside the sealed Definition. */
export interface EvaluationInfrastructure {
  /** Reuses or seeds completed Execution records under the sealed Core cache contract. */
  readonly executionCache?: ExecutionCache;
  /** Reuses or seeds completed Evaluation records under the sealed Core cache contract. */
  readonly evaluationCache?: EvaluationCache;
  /** One content-addressed store serves output, trace, and Evaluator evidence. */
  readonly contentStore?: ContentStore;
  /** Resolves reference-captured content for downstream Evaluators. */
  readonly contentResolver?: ContentResolver;
  /** Independent host boundary required before transparent Execution reuse. */
  readonly executorIdentityVerifier?: ExecutorIdentityVerifier;
}

export interface CapturedEvaluationInfrastructure {
  readonly support: EvaluationRuntimeSupportPorts;
  readonly executorIdentityVerifier?: ExecutorIdentityVerifier;
}

function bindMethod<Arguments extends readonly unknown[], Result>(
  owner: object,
  method: (...arguments_: Arguments) => Result,
  label: string,
): (...arguments_: Arguments) => Result {
  if (typeof method !== 'function') {
    throw new TypeError(`${label} must be a function.`);
  }
  return (...arguments_) => Reflect.apply(method, owner, arguments_) as Result;
}

export function captureEvaluationInfrastructure(
  value: unknown,
): CapturedEvaluationInfrastructure | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Evaluation infrastructure must be an object.');
  }
  const input = value as Readonly<EvaluationInfrastructure>;
  if (Object.keys(input).some((key) => ![
    'executionCache',
    'evaluationCache',
    'contentStore',
    'contentResolver',
    'executorIdentityVerifier',
  ].includes(key))) {
    throw new TypeError('Evaluation infrastructure contains unsupported fields.');
  }
  const declaredExecutionCache = input.executionCache;
  const declaredEvaluationCache = input.evaluationCache;
  const declaredContentStore = input.contentStore;
  const declaredContentResolver = input.contentResolver;
  const declaredVerifier = input.executorIdentityVerifier;
  const executionCache = declaredExecutionCache === undefined
    ? undefined
    : Object.freeze({
        get: bindMethod(declaredExecutionCache, declaredExecutionCache.get, 'ExecutionCache.get'),
        put: bindMethod(declaredExecutionCache, declaredExecutionCache.put, 'ExecutionCache.put'),
      });
  const evaluationCache = declaredEvaluationCache === undefined
    ? undefined
    : Object.freeze({
        get: bindMethod(declaredEvaluationCache, declaredEvaluationCache.get, 'EvaluationCache.get'),
        put: bindMethod(declaredEvaluationCache, declaredEvaluationCache.put, 'EvaluationCache.put'),
      });
  const contentStore = declaredContentStore === undefined
    ? undefined
    : Object.freeze({
        put: bindMethod(declaredContentStore, declaredContentStore.put, 'ContentStore.put'),
      });
  const contentResolver = declaredContentResolver === undefined
    ? undefined
    : Object.freeze({
        resolve: bindMethod<
          readonly [Readonly<ContentDescriptor>],
          Promise<{ value: JsonValue; classification: ContentValue['classification']; mediaType?: string }>
        >(
          declaredContentResolver,
          declaredContentResolver.resolve,
          'ContentResolver.resolve',
        ),
      }) as EvaluationContentResolver;
  const executorIdentityVerifier = declaredVerifier === undefined
    ? undefined
    : Object.freeze({
        verifierId: IdentifierSchema.parse(declaredVerifier.verifierId),
        verify: bindMethod(declaredVerifier, declaredVerifier.verify, 'ExecutorIdentityVerifier.verify'),
      });
  return Object.freeze({
    support: Object.freeze({
      ...(executionCache === undefined ? {} : { executionCache }),
      ...(evaluationCache === undefined ? {} : { evaluationCache }),
      ...(contentStore === undefined ? {} : {
        executionContentStore: contentStore,
        evaluationContentStore: contentStore,
      }),
      ...(contentResolver === undefined ? {} : { contentResolver }),
    }),
    ...(executorIdentityVerifier === undefined ? {} : { executorIdentityVerifier }),
  });
}

export async function promoteVerifiedExecutorIdentity(
  verifier: Readonly<ExecutorIdentityVerifier>,
  executor: EvaluationExecutor<JsonValue, JsonValue | undefined, JsonValue, JsonValue>,
  declaredIdentity: RuntimeIdentity,
): Promise<RuntimeIdentity> {
  const evidence = await verifier.verify(Object.freeze({ executor, declaredIdentity }));
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)
      || Object.keys(evidence).some((key) => key !== 'attestationDigest')) {
    throw new TypeError('Executor identity verification result is invalid.');
  }
  return deepFreezeCanonicalJson(RuntimeIdentitySchema.parse({
    ...declaredIdentity,
    assuranceLevel: 'verified',
    provenanceFacets: {
      ...(declaredIdentity.provenanceFacets?.observation === undefined
        ? {}
        : { observation: declaredIdentity.provenanceFacets.observation }),
      attestation: {
        attestationDigest: evidence.attestationDigest,
        attestorId: verifier.verifierId,
      },
    },
  }));
}
