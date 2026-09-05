import {
  ContentDescriptorSchema,
  canonicalizeJson,
  canonicalizeJsonBytes,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
} from '../../eval-core/contracts/index.js';
import type {
  ContentDescriptor,
  ContentResolver,
  ContentStore,
  ContentValue,
} from '../infrastructure.js';

export interface ContentStoreCheckInput {
  readonly contentStore: ContentStore;
  readonly contentResolver: ContentResolver;
  /** Optional harmless probe; defaults to fixed public JSON so repeated checks are idempotent. */
  readonly probe?: ContentValue;
  /** Per-operation check timeout. Defaults to 5 seconds. */
  readonly timeoutMs?: number;
}

export interface ContentStoreConformanceCheck {
  readonly checkId:
    | 'write-contract'
    | 'descriptor-integrity'
    | 'descriptor-stability'
    | 'resolve-contract'
    | 'value-integrity'
    | 'classification-integrity'
    | 'media-type-integrity';
  readonly checkStatus: 'passed' | 'failed';
  readonly reasonCode?: string;
}

export interface ContentStoreCheckResult {
  readonly conformant: boolean;
  readonly checks: readonly ContentStoreConformanceCheck[];
}

interface ContentStoreConformanceInput {
  readonly contentStore: ContentStore;
  readonly contentResolver: ContentResolver;
  readonly probe: ContentValue;
  readonly timeoutMs: number;
}

class ContentStoreConformanceTimeout extends Error {}

async function bounded<Output>(operation: Promise<Output>, timeoutMs: number): Promise<Output> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<Output>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new ContentStoreConformanceTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function check(
  checkId: ContentStoreConformanceCheck['checkId'],
  passed: boolean,
  reasonCode: string,
): ContentStoreConformanceCheck {
  return Object.freeze({
    checkId,
    checkStatus: passed ? 'passed' : 'failed',
    ...(passed ? {} : { reasonCode }),
  });
}

function result(checks: readonly ContentStoreConformanceCheck[]): ContentStoreCheckResult {
  const captured = Object.freeze([...checks]);
  return Object.freeze({
    conformant: captured.every((candidate) => candidate.checkStatus === 'passed'),
    checks: captured,
  });
}

function matchingDescriptor(
  descriptor: unknown,
  expected: Readonly<{
    digest: string;
    mediaType: string;
    size: number;
  }>,
): ContentDescriptor | undefined {
  const parsed = ContentDescriptorSchema.safeParse(descriptor);
  if (!parsed.success
      || parsed.data.digest !== expected.digest
      || parsed.data.mediaType !== expected.mediaType
      || (parsed.data.size !== undefined && parsed.data.size !== expected.size)) {
    return undefined;
  }
  return parsed.data;
}

function canonicalValueMatches(actual: unknown, expected: ContentValue['value']): boolean {
  try {
    return canonicalizeJson(actual) === canonicalizeJson(expected);
  } catch {
    return false;
  }
}

/** Runs a representative, idempotent round trip without retaining payloads or host errors. */
export async function runContentStoreConformance(
  input: Readonly<ContentStoreConformanceInput>,
): Promise<ContentStoreCheckResult> {
  const mediaType = input.probe.mediaType ?? 'application/json';
  const value = deepFreezeCanonicalJson(structuredClone(input.probe.value));
  const request = deepFreezeCanonicalJson({
    value,
    classification: input.probe.classification,
    mediaType,
    digest: digestCanonicalJson(value),
  });
  const expectedDescriptor = {
    digest: request.digest,
    mediaType,
    size: canonicalizeJsonBytes(value).byteLength,
  };
  let first: unknown;
  let second: unknown;
  try {
    first = structuredClone(await bounded(input.contentStore.put(request), input.timeoutMs));
    second = structuredClone(await bounded(input.contentStore.put(request), input.timeoutMs));
  } catch (error) {
    return result([check(
      'write-contract',
      false,
      error instanceof ContentStoreConformanceTimeout
        ? 'content-store-write-timeout'
        : 'content-store-write-failed',
    )]);
  }
  const firstDescriptor = matchingDescriptor(first, expectedDescriptor);
  const secondDescriptor = matchingDescriptor(second, expectedDescriptor);
  const checks: ContentStoreConformanceCheck[] = [
    check('write-contract', true, 'content-store-write-failed'),
    check(
      'descriptor-integrity',
      firstDescriptor !== undefined && secondDescriptor !== undefined,
      'content-store-descriptor-invalid',
    ),
  ];
  if (firstDescriptor === undefined || secondDescriptor === undefined) return result(checks);
  checks.push(check(
    'descriptor-stability',
    canonicalizeJson(firstDescriptor) === canonicalizeJson(secondDescriptor),
    'content-store-descriptor-unstable',
  ));

  let resolved: ContentValue;
  try {
    resolved = await bounded(
      input.contentResolver.resolve(deepFreezeCanonicalJson(firstDescriptor)),
      input.timeoutMs,
    );
  } catch (error) {
    checks.push(check(
      'resolve-contract',
      false,
      error instanceof ContentStoreConformanceTimeout
        ? 'content-resolver-read-timeout'
        : 'content-resolver-read-failed',
    ));
    return result(checks);
  }
  checks.push(
    check('resolve-contract', true, 'content-resolver-read-failed'),
    check(
      'value-integrity',
      canonicalValueMatches(resolved?.value, value),
      'content-resolver-value-mismatch',
    ),
    check(
      'classification-integrity',
      resolved?.classification === request.classification,
      'content-resolver-classification-mismatch',
    ),
    check(
      'media-type-integrity',
      resolved?.mediaType === undefined || resolved.mediaType === mediaType,
      'content-resolver-media-type-mismatch',
    ),
  );
  return result(checks);
}
