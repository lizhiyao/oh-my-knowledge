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
  evaluationRecordCapturedContents,
  type CapturedContent,
  type JsonValue,
  type Sha256Digest,
} from '../eval-core/contracts/index.js';
import {
  getPreparedEvaluationPlanDigest,
  getRestorableEvaluationResultPlanDigest,
  restorePreparedEvaluationResult,
  type EvaluationResult,
  type PreparedEvaluation,
} from './evaluate.js';
import type {
  ContentDescriptor,
  ContentResolver,
  ContentStore,
  ContentStoreRequest,
  ContentValue,
} from './infrastructure.js';

export const EVALUATION_RESULT_MEDIA_TYPE =
  'application/vnd.omk.evaluation-result+json;version=1';

const STORED_EVALUATION_RESULT_SCHEMA_VERSION = 'omk.eval-runtime.stored-result/v1' as const;

const StoredEvaluationResultSchema = z.object({
  schemaVersion: z.literal(STORED_EVALUATION_RESULT_SCHEMA_VERSION),
  planDigest: Sha256DigestSchema,
  result: JsonValueSchema,
}).strict();

type StoredEvaluationResult = z.infer<typeof StoredEvaluationResultSchema>;

export interface SaveEvaluationResultInput {
  readonly result: EvaluationResult;
  readonly store: ContentStore;
}

export interface LoadEvaluationResultInput {
  readonly prepared: PreparedEvaluation;
  readonly reference: ContentDescriptor;
  readonly resolver: ContentResolver;
  /** Independent host trust boundary; storage-integrity checks alone are not provenance proof. */
  readonly verifier: EvaluationResultVerifier;
}

export interface EvaluationResultVerificationRequest {
  readonly reference: ContentDescriptor;
  readonly planDigest: PreparedEvaluation['planDigest'];
}

export interface EvaluationResultVerification {
  /** Must bind the attestation to the exact stored envelope digest. */
  readonly verifiedResultDigest: ContentDescriptor['digest'];
  readonly attestationDigest: ContentDescriptor['digest'];
  /** Independently authenticated Bundle provenance claims. */
  readonly verifiedProvenanceBundleDigests: readonly ContentDescriptor['digest'][];
  /** Independently authenticated cache receipts; never inferred from a Bundle claim. */
  readonly verifiedCacheRecordDigests: readonly ContentDescriptor['digest'][];
  /** Independently authenticated Decision policy executions. */
  readonly verifiedPolicyExecutionDigests: readonly ContentDescriptor['digest'][];
}

export interface EvaluationResultVerifier {
  readonly verifierId: string;
  /**
   * Authenticates the producing Runtime, provenance, cache receipts, budget claims, and policy
   * execution for the exact referenced result. A checksum-only verifier is insufficient.
   */
  verify(
    request: Readonly<EvaluationResultVerificationRequest>,
  ): Promise<EvaluationResultVerification>;
}

export class EvaluationResultStoreError extends Error {
  readonly code:
    | 'EVAL_RUNTIME_RESULT_NOT_CANONICAL'
    | 'EVAL_RUNTIME_RESULT_STORE_FAILED'
    | 'EVAL_RUNTIME_RESULT_REFERENCE_INVALID'
    | 'EVAL_RUNTIME_RESULT_RESOLVE_FAILED'
    | 'EVAL_RUNTIME_RESULT_VERIFICATION_FAILED'
    | 'EVAL_RUNTIME_RESULT_CONTENT_INVALID'
    | 'EVAL_RUNTIME_RESULT_PLAN_MISMATCH';

  constructor(code: EvaluationResultStoreError['code'], message: string) {
    super(message);
    this.name = 'EvaluationResultStoreError';
    this.code = code;
  }
}

function failure(
  code: EvaluationResultStoreError['code'],
  message: string,
): never {
  throw new EvaluationResultStoreError(code, message);
}

function captureMethod<Arguments extends readonly unknown[], Result>(
  owner: object,
  method: (...arguments_: Arguments) => Result,
  code: EvaluationResultStoreError['code'],
  message: string,
): (...arguments_: Arguments) => Result {
  if (typeof method !== 'function') return failure(code, message);
  return (...arguments_) => Reflect.apply(method, owner, arguments_) as Result;
}

function createStoredResult(result: EvaluationResult): Readonly<StoredEvaluationResult> {
  const planDigest = getRestorableEvaluationResultPlanDigest(result);
  if (planDigest === undefined) {
    return failure(
      'EVAL_RUNTIME_RESULT_NOT_CANONICAL',
      'Evaluation result 必须是 canonical Runtime 产生或恢复的原始结果。',
    );
  }
  const resultValue = JsonValueSchema.safeParse(structuredClone(result));
  if (!resultValue.success) {
    return failure(
      'EVAL_RUNTIME_RESULT_NOT_CANONICAL',
      'Evaluation result 不是可持久化的 canonical JSON。',
    );
  }
  return deepFreezeCanonicalJson({
    schemaVersion: STORED_EVALUATION_RESULT_SCHEMA_VERSION,
    planDigest,
    result: resultValue.data,
  } as JsonValue) as Readonly<StoredEvaluationResult>;
}

/** Persists one canonical Runtime result through an explicitly injected host store. */
export async function saveEvaluationResult(
  input: Readonly<SaveEvaluationResultInput>,
): Promise<ContentDescriptor> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['result', 'store'].includes(key))) {
    return failure('EVAL_RUNTIME_RESULT_NOT_CANONICAL', 'Evaluation result save input 无效。');
  }
  const stored = createStoredResult(input.result);
  const digest = digestCanonicalJson(stored);
  let put: (request: Readonly<ContentStoreRequest>) => Promise<ContentDescriptor>;
  try {
    const store = input.store;
    put = captureMethod(
      store,
      store.put,
      'EVAL_RUNTIME_RESULT_STORE_FAILED',
      'Evaluation result store declaration 无效。',
    );
  } catch {
    return failure('EVAL_RUNTIME_RESULT_STORE_FAILED', 'Evaluation result store declaration 无效。');
  }
  let returned: unknown;
  try {
    returned = structuredClone(await put(deepFreezeCanonicalJson({
      value: stored as unknown as JsonValue,
      classification: 'gold',
      digest,
      mediaType: EVALUATION_RESULT_MEDIA_TYPE,
    })));
  } catch {
    return failure('EVAL_RUNTIME_RESULT_STORE_FAILED', 'Evaluation result store 写入失败。');
  }
  const descriptor = ContentDescriptorSchema.safeParse(returned);
  const size = canonicalizeJsonBytes(stored).byteLength;
  if (!descriptor.success
      || descriptor.data.digest !== digest
      || descriptor.data.mediaType !== EVALUATION_RESULT_MEDIA_TYPE
      || (descriptor.data.size !== undefined && descriptor.data.size !== size)) {
    return failure(
      'EVAL_RUNTIME_RESULT_STORE_FAILED',
      'Evaluation result store 返回了不匹配的 reference。',
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
    return failure('EVAL_RUNTIME_RESULT_CONTENT_INVALID', 'Evaluation result content 无效。');
  }
  const content = value as Readonly<Record<string, unknown>>;
  if (Object.keys(content).some((key) => !['value', 'classification', 'mediaType'].includes(key))
      || content.classification !== expected.classification
      || (content.mediaType !== undefined
        && content.mediaType !== expected.mediaType)) {
    return failure('EVAL_RUNTIME_RESULT_CONTENT_INVALID', 'Evaluation result content 元数据无效。');
  }
  const parsedValue = JsonValueSchema.safeParse(content.value);
  if (!parsedValue.success) {
    return failure('EVAL_RUNTIME_RESULT_CONTENT_INVALID', 'Evaluation result content 不是 canonical JSON。');
  }
  return Object.freeze({
    value: deepFreezeCanonicalJson(parsedValue.data),
    classification: expected.classification,
    mediaType: expected.mediaType,
  });
}

function resultReferencedContents(result: EvaluationResult): readonly CapturedContent[] {
  const artifacts = result.artifacts;
  if (artifacts?.execution === undefined || artifacts.evaluation === undefined) return [];
  const execution = artifacts.execution.records.flatMap((record) => (
    record.executionStatus === 'budget-censored'
      ? []
      : [
          ...(record.trace === undefined ? [] : [record.trace]),
          ...(record.executionStatus === 'completed' && record.output !== undefined
            ? [record.output]
            : []),
        ]
  ));
  const evaluation = artifacts.evaluation.records.flatMap(
    evaluationRecordCapturedContents,
  );
  return [...execution, ...evaluation].filter((content) => (
    content.contentKind === 'descriptor'
  ));
}

async function validateReferencedContentClosure(
  result: EvaluationResult,
  resolve: (descriptor: Readonly<ContentDescriptor>) => Promise<ContentValue>,
): Promise<void> {
  const references = new Map<string, Extract<CapturedContent, { contentKind: 'descriptor' }>>();
  for (const content of resultReferencedContents(result)) {
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
        'EVAL_RUNTIME_RESULT_RESOLVE_FAILED',
        'Evaluation result referenced content resolve 失败。',
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
        'EVAL_RUNTIME_RESULT_CONTENT_INVALID',
        'Evaluation result referenced content 与 descriptor 不匹配。',
      );
    }
  }
}

/** Resolves and re-admits one result against the caller's exact prepared contract. */
export async function loadEvaluationResult(
  input: Readonly<LoadEvaluationResultInput>,
): Promise<EvaluationResult> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => ![
        'prepared',
        'reference',
        'resolver',
        'verifier',
      ].includes(key))) {
    return failure('EVAL_RUNTIME_RESULT_REFERENCE_INVALID', 'Evaluation result load input 无效。');
  }
  const reference = ContentDescriptorSchema.safeParse(input.reference);
  if (!reference.success || reference.data.mediaType !== EVALUATION_RESULT_MEDIA_TYPE) {
    return failure('EVAL_RUNTIME_RESULT_REFERENCE_INVALID', 'Evaluation result reference 无效。');
  }
  const capturedReference = deepFreezeCanonicalJson(reference.data);
  const preparedPlanDigest = getPreparedEvaluationPlanDigest(input.prepared);
  if (preparedPlanDigest === undefined) {
    return failure(
      'EVAL_RUNTIME_RESULT_REFERENCE_INVALID',
      'Evaluation result load 需要当前 Runtime 创建的 PreparedEvaluation。',
    );
  }
  let resolve: (descriptor: Readonly<ContentDescriptor>) => Promise<ContentValue>;
  try {
    const resolver = input.resolver;
    resolve = captureMethod(
      resolver,
      resolver.resolve,
      'EVAL_RUNTIME_RESULT_RESOLVE_FAILED',
      'Evaluation result resolver declaration 无效。',
    );
  } catch {
    return failure('EVAL_RUNTIME_RESULT_RESOLVE_FAILED', 'Evaluation result resolver declaration 无效。');
  }
  let resolved: unknown;
  try {
    resolved = structuredClone(await resolve(capturedReference));
  } catch {
    return failure('EVAL_RUNTIME_RESULT_RESOLVE_FAILED', 'Evaluation result resolve 失败。');
  }
  const content = validateResolvedContent(resolved, {
    classification: 'gold',
    mediaType: EVALUATION_RESULT_MEDIA_TYPE,
  });
  if (digestCanonicalJson(content.value) !== capturedReference.digest) {
    return failure('EVAL_RUNTIME_RESULT_CONTENT_INVALID', 'Evaluation result content digest 不匹配。');
  }
  const stored = StoredEvaluationResultSchema.safeParse(content.value);
  if (!stored.success) {
    return failure('EVAL_RUNTIME_RESULT_CONTENT_INVALID', 'Evaluation result content schema 无效。');
  }
  if (stored.data.planDigest !== preparedPlanDigest) {
    return failure(
      'EVAL_RUNTIME_RESULT_PLAN_MISMATCH',
      'Evaluation result 与 prepared evaluation 的 sealed plan 不匹配。',
    );
  }
  let verify: (
    request: Readonly<EvaluationResultVerificationRequest>,
  ) => Promise<EvaluationResultVerification>;
  try {
    const verifier = input.verifier;
    IdentifierSchema.parse(verifier.verifierId);
    verify = captureMethod(
      verifier,
      verifier.verify,
      'EVAL_RUNTIME_RESULT_VERIFICATION_FAILED',
      'Evaluation result verifier declaration 无效。',
    );
  } catch {
    return failure(
      'EVAL_RUNTIME_RESULT_VERIFICATION_FAILED',
      'Evaluation result verifier declaration 无效。',
    );
  }
  let verification: unknown;
  try {
    verification = structuredClone(await verify(Object.freeze({
      reference: capturedReference,
      planDigest: stored.data.planDigest,
    })));
  } catch {
    return failure(
      'EVAL_RUNTIME_RESULT_VERIFICATION_FAILED',
      'Evaluation result trust verification 失败。',
    );
  }
  const parsedVerification = z.object({
    verifiedResultDigest: Sha256DigestSchema,
    attestationDigest: Sha256DigestSchema,
    verifiedProvenanceBundleDigests: z.array(Sha256DigestSchema),
    verifiedCacheRecordDigests: z.array(Sha256DigestSchema),
    verifiedPolicyExecutionDigests: z.array(Sha256DigestSchema),
  }).strict().safeParse(verification);
  if (!parsedVerification.success
      || parsedVerification.data.verifiedResultDigest !== capturedReference.digest
      || new Set(parsedVerification.data.verifiedProvenanceBundleDigests).size
        !== parsedVerification.data.verifiedProvenanceBundleDigests.length
      || new Set(parsedVerification.data.verifiedCacheRecordDigests).size
        !== parsedVerification.data.verifiedCacheRecordDigests.length
      || new Set(parsedVerification.data.verifiedPolicyExecutionDigests).size
        !== parsedVerification.data.verifiedPolicyExecutionDigests.length) {
    return failure(
      'EVAL_RUNTIME_RESULT_VERIFICATION_FAILED',
      'Evaluation result verifier 未认证当前 reference。',
    );
  }
  try {
    const restored = restorePreparedEvaluationResult(input.prepared, stored.data.result, {
      verifiedProvenanceBundleDigests: new Set(
        parsedVerification.data.verifiedProvenanceBundleDigests as Sha256Digest[],
      ),
      verifiedCacheRecordDigests: new Set(
        parsedVerification.data.verifiedCacheRecordDigests as Sha256Digest[],
      ),
      verifiedPolicyExecutionDigests: new Set(
        parsedVerification.data.verifiedPolicyExecutionDigests as Sha256Digest[],
      ),
    });
    if (canonicalizeJson(restored) !== canonicalizeJson(stored.data.result)) {
      return failure('EVAL_RUNTIME_RESULT_CONTENT_INVALID', 'Evaluation result 恢复结果不一致。');
    }
    await validateReferencedContentClosure(restored, resolve);
    return restored;
  } catch (error) {
    if (error instanceof EvaluationResultStoreError) throw error;
    return failure('EVAL_RUNTIME_RESULT_CONTENT_INVALID', 'Evaluation result 未通过 Core admission。');
  }
}
