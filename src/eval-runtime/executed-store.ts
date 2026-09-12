import { z } from 'zod';
import {
  ContentDescriptorSchema,
  IdentifierSchema,
  JsonValueSchema,
  Sha256DigestSchema,
  canonicalizeJson,
  canonicalizeJsonBytes,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  parseExecutionBundleDocument,
  type CapturedContent,
  type ExecutionBundle,
  type JsonValue,
  type Sha256Digest,
} from '../eval-core/contracts/index.js';
import {
  executedEvaluations,
} from './evaluation/result-state.js';
import type { ExecutedEvaluation } from './evaluation/contracts.js';
import type {
  ContentDescriptor,
  ContentResolver,
  ContentStore,
  ContentStoreRequest,
  ContentValue,
} from './infrastructure.js';

export const EXECUTED_EVALUATION_MEDIA_TYPE =
  'application/vnd.omk.executed-evaluation+json;version=1';

const STORED_EXECUTED_SCHEMA_VERSION = 'omk.eval-runtime.stored-executed/v1' as const;

const StoredExecutedEvaluationSchema = z.object({
  schemaVersion: z.literal(STORED_EXECUTED_SCHEMA_VERSION),
  executionPlanDigest: Sha256DigestSchema,
  executionInputDigest: Sha256DigestSchema,
  bundle: JsonValueSchema,
}).strict();

type StoredExecutedEvaluation = z.infer<typeof StoredExecutedEvaluationSchema>;

export interface SaveExecutedEvaluationInput {
  readonly executed: ExecutedEvaluation;
  readonly store: ContentStore;
}

export interface LoadExecutedEvaluationInput {
  readonly reference: ContentDescriptor;
  readonly resolver: ContentResolver;
  /** Independent host trust boundary; storage-integrity checks alone are not provenance proof. */
  readonly verifier: ExecutedEvaluationVerifier;
}

export interface ExecutedEvaluationVerificationRequest {
  readonly reference: ContentDescriptor;
  readonly executionPlanDigest: Sha256Digest;
  readonly executionInputDigest: Sha256Digest;
}

export interface ExecutedEvaluationVerification {
  /** Must bind the attestation to the exact stored envelope digest. */
  readonly verifiedExecutedDigest: ContentDescriptor['digest'];
  readonly attestationDigest: ContentDescriptor['digest'];
  /** Independently authenticated Bundle provenance claims. */
  readonly verifiedProvenanceBundleDigests: readonly ContentDescriptor['digest'][];
  /** Independently authenticated cache receipts; never inferred from a Bundle claim. */
  readonly verifiedCacheRecordDigests: readonly ContentDescriptor['digest'][];
}

export interface ExecutedEvaluationVerifier {
  readonly verifierId: string;
  /**
   * Authenticates the producing Runtime, provenance and cache receipts for the exact referenced
   * execution envelope. A checksum-only verifier is insufficient.
   */
  verify(
    request: Readonly<ExecutedEvaluationVerificationRequest>,
  ): Promise<ExecutedEvaluationVerification>;
}

export class ExecutedEvaluationStoreError extends Error {
  readonly code:
    | 'EVAL_RUNTIME_EXECUTED_NOT_CANONICAL'
    | 'EVAL_RUNTIME_EXECUTED_STORE_FAILED'
    | 'EVAL_RUNTIME_EXECUTED_REFERENCE_INVALID'
    | 'EVAL_RUNTIME_EXECUTED_RESOLVE_FAILED'
    | 'EVAL_RUNTIME_EXECUTED_VERIFICATION_FAILED'
    | 'EVAL_RUNTIME_EXECUTED_CONTENT_INVALID';

  constructor(code: ExecutedEvaluationStoreError['code'], message: string) {
    super(message);
    this.name = 'ExecutedEvaluationStoreError';
    this.code = code;
  }
}

function failure(
  code: ExecutedEvaluationStoreError['code'],
  message: string,
): never {
  throw new ExecutedEvaluationStoreError(code, message);
}

function captureMethod<Arguments extends readonly unknown[], Result>(
  owner: object,
  method: (...arguments_: Arguments) => Result,
  code: ExecutedEvaluationStoreError['code'],
  message: string,
): (...arguments_: Arguments) => Result {
  if (typeof method !== 'function') return failure(code, message);
  return (...arguments_) => Reflect.apply(method, owner, arguments_) as Result;
}

function executionReferencedContents(
  bundle: ExecutionBundle,
): readonly CapturedContent[] {
  return bundle.records.flatMap((record) => (
    record.executionStatus === 'budget-censored'
      ? []
      : [
          ...(record.trace === undefined ? [] : [record.trace]),
          ...(record.executionStatus === 'completed' && record.output !== undefined
            ? [record.output]
            : []),
        ]
  )).filter((content) => content.contentKind === 'descriptor');
}

/** @internal One canonical handle's envelope, or a fail-closed rejection. */
function createStoredEnvelope(
  executed: ExecutedEvaluation,
): Readonly<StoredExecutedEvaluation> {
  const state = executedEvaluations.get(executed);
  if (state === undefined) {
    return failure(
      'EVAL_RUNTIME_EXECUTED_NOT_CANONICAL',
      '执行句柄必须是 canonical Runtime 产生或经宿主 verifier 载入的原始句柄。',
    );
  }
  if (executed.bundle !== state.bundle
      || executed.executionPlanDigest !== state.bundle.executionPlanDigest
      || executed.executionInputDigest !== state.bundle.executionInputDigest) {
    return failure(
      'EVAL_RUNTIME_EXECUTED_NOT_CANONICAL',
      '执行句柄与其 ExecutionBundle 身份不一致。',
    );
  }
  const bundle = JsonValueSchema.safeParse(structuredClone(state.bundle));
  if (!bundle.success) {
    return failure(
      'EVAL_RUNTIME_EXECUTED_NOT_CANONICAL',
      'ExecutionBundle 不是可持久化的 canonical JSON。',
    );
  }
  return deepFreezeCanonicalJson({
    schemaVersion: STORED_EXECUTED_SCHEMA_VERSION,
    executionPlanDigest: state.bundle.executionPlanDigest as Sha256Digest,
    executionInputDigest: state.bundle.executionInputDigest as Sha256Digest,
    bundle: bundle.data,
  } as JsonValue) as Readonly<StoredExecutedEvaluation>;
}

/**
 * Persists one execution envelope through an explicitly injected host store, so scoring can
 * happen in a later process. The envelope holds Target evidence only and is classified `gold`:
 * it must not be handed to a Target as context.
 */
export async function saveExecutedEvaluation(
  input: Readonly<SaveExecutedEvaluationInput>,
): Promise<ContentDescriptor> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['executed', 'store'].includes(key))) {
    return failure('EVAL_RUNTIME_EXECUTED_NOT_CANONICAL', '执行句柄保存 input 无效。');
  }
  const stored = createStoredEnvelope(input.executed);
  const digest = digestCanonicalJson(stored);
  let put: (request: Readonly<ContentStoreRequest>) => Promise<ContentDescriptor>;
  try {
    const store = input.store;
    put = captureMethod(
      store,
      store.put,
      'EVAL_RUNTIME_EXECUTED_STORE_FAILED',
      '执行句柄 store declaration 无效。',
    );
  } catch {
    return failure('EVAL_RUNTIME_EXECUTED_STORE_FAILED', '执行句柄 store declaration 无效。');
  }
  let returned: unknown;
  try {
    returned = structuredClone(await put(deepFreezeCanonicalJson({
      value: stored as unknown as JsonValue,
      classification: 'gold',
      digest,
      mediaType: EXECUTED_EVALUATION_MEDIA_TYPE,
    })));
  } catch {
    return failure('EVAL_RUNTIME_EXECUTED_STORE_FAILED', '执行句柄 store 写入失败。');
  }
  const descriptor = ContentDescriptorSchema.safeParse(returned);
  const size = canonicalizeJsonBytes(stored).byteLength;
  if (!descriptor.success
      || descriptor.data.digest !== digest
      || descriptor.data.mediaType !== EXECUTED_EVALUATION_MEDIA_TYPE
      || (descriptor.data.size !== undefined && descriptor.data.size !== size)) {
    return failure(
      'EVAL_RUNTIME_EXECUTED_STORE_FAILED',
      '执行句柄 store 返回了不匹配的 reference。',
    );
  }
  return deepFreezeCanonicalJson(descriptor.data);
}

function validateResolvedContent(
  value: unknown,
  expected: Readonly<{
    classification: ContentValue['classification'];
    mediaType: string;
  }>,
): Readonly<ContentValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return failure('EVAL_RUNTIME_EXECUTED_CONTENT_INVALID', '执行句柄 content 无效。');
  }
  const content = value as Readonly<Record<string, unknown>>;
  if (Object.keys(content).some((key) => !['value', 'classification', 'mediaType'].includes(key))
      || content.classification !== expected.classification
      || (content.mediaType !== undefined
        && content.mediaType !== expected.mediaType)) {
    return failure('EVAL_RUNTIME_EXECUTED_CONTENT_INVALID', '执行句柄 content 元数据无效。');
  }
  const parsedValue = JsonValueSchema.safeParse(content.value);
  if (!parsedValue.success) {
    return failure(
      'EVAL_RUNTIME_EXECUTED_CONTENT_INVALID',
      '执行句柄 content 不是 canonical JSON。',
    );
  }
  return Object.freeze({
    value: deepFreezeCanonicalJson(parsedValue.data),
    classification: expected.classification,
    mediaType: expected.mediaType,
  });
}

async function validateReferencedContentClosure(
  bundle: ExecutionBundle,
  resolve: (descriptor: Readonly<ContentDescriptor>) => Promise<ContentValue>,
): Promise<void> {
  const references = new Map<string, Extract<CapturedContent, { contentKind: 'descriptor' }>>();
  for (const content of executionReferencedContents(bundle)) {
    if (content.contentKind !== 'descriptor') continue;
    references.set(canonicalizeJson({
      descriptor: content.descriptor,
      classification: content.classification,
    }), content);
  }
  for (const content of references.values()) {
    let raw: unknown;
    try {
      raw = structuredClone(await resolve(content.descriptor));
    } catch {
      return failure(
        'EVAL_RUNTIME_EXECUTED_RESOLVE_FAILED',
        '执行句柄 referenced content resolve 失败。',
      );
    }
    const resolved = validateResolvedContent(raw, {
      classification: content.classification,
      mediaType: content.descriptor.mediaType,
    });
    if (digestCanonicalJson(resolved.value) !== content.descriptor.digest
        || (content.descriptor.size !== undefined
          && canonicalizeJsonBytes(resolved.value).byteLength !== content.descriptor.size)) {
      return failure(
        'EVAL_RUNTIME_EXECUTED_CONTENT_INVALID',
        '执行句柄 referenced content 与 descriptor 不匹配。',
      );
    }
  }
}

/** Resolves and re-admits one execution envelope as a handle; plan binding happens at scoring. */
export async function loadExecutedEvaluation(
  input: Readonly<LoadExecutedEvaluationInput>,
): Promise<ExecutedEvaluation> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => ![
        'reference',
        'resolver',
        'verifier',
      ].includes(key))) {
    return failure('EVAL_RUNTIME_EXECUTED_REFERENCE_INVALID', '执行句柄载入 input 无效。');
  }
  const reference = ContentDescriptorSchema.safeParse(input.reference);
  if (!reference.success || reference.data.mediaType !== EXECUTED_EVALUATION_MEDIA_TYPE) {
    return failure('EVAL_RUNTIME_EXECUTED_REFERENCE_INVALID', '执行句柄 reference 无效。');
  }
  const capturedReference = deepFreezeCanonicalJson(reference.data);
  let resolve: (descriptor: Readonly<ContentDescriptor>) => Promise<ContentValue>;
  try {
    const resolver = input.resolver;
    resolve = captureMethod(
      resolver,
      resolver.resolve,
      'EVAL_RUNTIME_EXECUTED_RESOLVE_FAILED',
      '执行句柄 resolver declaration 无效。',
    );
  } catch {
    return failure('EVAL_RUNTIME_EXECUTED_RESOLVE_FAILED', '执行句柄 resolver declaration 无效。');
  }
  let resolved: unknown;
  try {
    resolved = structuredClone(await resolve(capturedReference));
  } catch {
    return failure('EVAL_RUNTIME_EXECUTED_RESOLVE_FAILED', '执行句柄 resolve 失败。');
  }
  const content = validateResolvedContent(resolved, {
    classification: 'gold',
    mediaType: EXECUTED_EVALUATION_MEDIA_TYPE,
  });
  if (digestCanonicalJson(content.value) !== capturedReference.digest) {
    return failure('EVAL_RUNTIME_EXECUTED_CONTENT_INVALID', '执行句柄 content digest 不匹配。');
  }
  const stored = StoredExecutedEvaluationSchema.safeParse(content.value);
  if (!stored.success) {
    return failure('EVAL_RUNTIME_EXECUTED_CONTENT_INVALID', '执行句柄 content schema 无效。');
  }
  let bundle: ExecutionBundle;
  try {
    bundle = parseExecutionBundleDocument(stored.data.bundle);
  } catch {
    return failure('EVAL_RUNTIME_EXECUTED_CONTENT_INVALID', 'ExecutionBundle 未通过 canonical 校验。');
  }
  if (stored.data.executionPlanDigest !== bundle.executionPlanDigest
      || stored.data.executionInputDigest !== bundle.executionInputDigest) {
    return failure(
      'EVAL_RUNTIME_EXECUTED_CONTENT_INVALID',
      '执行句柄 envelope 与 ExecutionBundle 身份不一致。',
    );
  }
  let verify: (
    request: Readonly<ExecutedEvaluationVerificationRequest>,
  ) => Promise<ExecutedEvaluationVerification>;
  try {
    const verifier = input.verifier;
    IdentifierSchema.parse(verifier.verifierId);
    verify = captureMethod(
      verifier,
      verifier.verify,
      'EVAL_RUNTIME_EXECUTED_VERIFICATION_FAILED',
      '执行句柄 verifier declaration 无效。',
    );
  } catch {
    return failure(
      'EVAL_RUNTIME_EXECUTED_VERIFICATION_FAILED',
      '执行句柄 verifier declaration 无效。',
    );
  }
  let verification: unknown;
  try {
    verification = structuredClone(await verify(Object.freeze({
      reference: capturedReference,
      executionPlanDigest: stored.data.executionPlanDigest as Sha256Digest,
      executionInputDigest: stored.data.executionInputDigest as Sha256Digest,
    })));
  } catch {
    return failure(
      'EVAL_RUNTIME_EXECUTED_VERIFICATION_FAILED',
      '执行句柄 trust verification 失败。',
    );
  }
  const parsedVerification = z.object({
    verifiedExecutedDigest: Sha256DigestSchema,
    attestationDigest: Sha256DigestSchema,
    verifiedProvenanceBundleDigests: z.array(Sha256DigestSchema),
    verifiedCacheRecordDigests: z.array(Sha256DigestSchema),
  }).strict().safeParse(verification);
  if (!parsedVerification.success
      || parsedVerification.data.verifiedExecutedDigest !== capturedReference.digest
      || new Set(parsedVerification.data.verifiedProvenanceBundleDigests).size
        !== parsedVerification.data.verifiedProvenanceBundleDigests.length
      || new Set(parsedVerification.data.verifiedCacheRecordDigests).size
        !== parsedVerification.data.verifiedCacheRecordDigests.length) {
    return failure(
      'EVAL_RUNTIME_EXECUTED_VERIFICATION_FAILED',
      '执行句柄 verifier 未认证当前 reference。',
    );
  }
  const executed: ExecutedEvaluation = Object.freeze({
    runId: bundle.budgetSummary.runId,
    executionPlanDigest: stored.data.executionPlanDigest as Sha256Digest,
    executionInputDigest: stored.data.executionInputDigest as Sha256Digest,
    bundle,
    bundleOrigin: 'store' as const,
  });
  executedEvaluations.set(executed, {
    bundle,
    verification: {
      verifiedProvenanceBundleDigests: new Set(
        parsedVerification.data.verifiedProvenanceBundleDigests as Sha256Digest[],
      ),
      verifiedCacheRecordDigests: new Set(
        parsedVerification.data.verifiedCacheRecordDigests as Sha256Digest[],
      ),
    },
  });
  await validateReferencedContentClosure(bundle, resolve);
  return executed;
}
