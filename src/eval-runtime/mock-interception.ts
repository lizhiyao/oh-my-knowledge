import {
  ExecutionResourceDescriptorSchema,
  IdentifierSchema,
  JsonValueSchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  type ExecutionResourceDescriptor,
  type JsonValue,
} from '../eval-core/contracts/index.js';

export const MOCK_INTERCEPTION_PLAN_MEDIA_TYPE =
  'application/vnd.omk.mock-interception-plan+json' as const;

export type MockInterceptionDescriptor = Readonly<ExecutionResourceDescriptor>;

export interface MockInterceptionOpenRequest {
  readonly descriptor: MockInterceptionDescriptor;
  readonly runId: string;
  readonly trialId: string;
  readonly sampleId: string;
  readonly variantId: string;
  readonly trialIndex: number;
  readonly trialSeed?: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  /** Attempt cancellation also bounds interceptor acquisition. */
  readonly signal: AbortSignal;
}

export interface MockInterceptionRequest {
  readonly callId: string;
  readonly toolName: string;
  readonly input: JsonValue;
  readonly signal: AbortSignal;
}

export type MockInterceptionDecision =
  | Readonly<{ decisionKind: 'mocked'; output: JsonValue }>
  | Readonly<{ decisionKind: 'pass-through' }>
  | Readonly<{ decisionKind: 'denied'; reasonCode: string }>;

export interface MockInterceptionLease {
  intercept(
    request: Readonly<MockInterceptionRequest>,
  ): Promise<MockInterceptionDecision>;
  close(): void | Promise<void>;
}

export interface MockInterceptionProvider {
  readonly providerId: string;
  readonly version: string;
  /** Measurement-relevant provider behavior only; rules and credentials stay outside identity. */
  readonly fingerprintFacets?: JsonValue;
  open(
    request: Readonly<MockInterceptionOpenRequest>,
  ): Promise<MockInterceptionLease>;
}

export interface MockInterceptionAccess {
  readonly descriptor: MockInterceptionDescriptor;
  intercept(
    request: Readonly<MockInterceptionRequest>,
  ): Promise<MockInterceptionDecision>;
}

export interface MockInterceptionPlan {
  readonly default?: MockInterceptionDescriptor;
  /** `null` explicitly disables the default interceptor for one sample. */
  readonly bySampleId?: Readonly<Record<string, MockInterceptionDescriptor | null>>;
}

export type MockInterceptionInput = MockInterceptionDescriptor | MockInterceptionPlan;

export interface CapturedMockInterceptionProvider {
  readonly providerId: string;
  readonly version: string;
  readonly fingerprintFacets?: JsonValue;
  open(
    request: Readonly<MockInterceptionOpenRequest>,
  ): Promise<MockInterceptionLease>;
}

export interface CapturedMockInterceptionPlan {
  readonly default?: MockInterceptionDescriptor;
  readonly bySampleId: Readonly<Record<string, MockInterceptionDescriptor | null>>;
}

function captureDescriptor(value: unknown): MockInterceptionDescriptor {
  const descriptor = ExecutionResourceDescriptorSchema.parse(structuredClone(value));
  if (descriptor.mediaType !== MOCK_INTERCEPTION_PLAN_MEDIA_TYPE
      || descriptor.classification !== 'secret') {
    throw new TypeError(
      `Mock interception descriptors require secret ${MOCK_INTERCEPTION_PLAN_MEDIA_TYPE} content.`,
    );
  }
  return deepFreezeCanonicalJson(descriptor);
}

export function captureMockInterceptionProvider(
  value: unknown,
): CapturedMockInterceptionProvider | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    throw new TypeError('Mock interception provider must be an object.');
  }
  const provider = value as Readonly<MockInterceptionProvider>;
  const providerId = IdentifierSchema.safeParse(provider.providerId);
  if (!providerId.success || typeof provider.version !== 'string' || provider.version.length === 0
      || typeof provider.open !== 'function') {
    throw new TypeError('Mock interception provider declaration is invalid.');
  }
  const fingerprintFacets = provider.fingerprintFacets === undefined
    ? undefined
    : deepFreezeCanonicalJson(JsonValueSchema.parse(structuredClone(provider.fingerprintFacets)));
  const open = provider.open;
  return Object.freeze({
    providerId: providerId.data,
    version: provider.version,
    ...(fingerprintFacets === undefined ? {} : { fingerprintFacets }),
    open: (request: Readonly<MockInterceptionOpenRequest>) => (
      Reflect.apply(open, provider, [request]) as Promise<MockInterceptionLease>
    ),
  });
}

function sameDescriptor(
  left: MockInterceptionDescriptor | undefined,
  right: MockInterceptionDescriptor,
): boolean {
  return left !== undefined && canonicalizeJson(left) === canonicalizeJson(right);
}

export function captureMockInterceptionPlan(
  value: unknown,
  sampleIds: ReadonlySet<string>,
): CapturedMockInterceptionPlan | undefined {
  if (value === undefined) return undefined;
  const direct = ExecutionResourceDescriptorSchema.safeParse(value);
  if (direct.success) {
    return Object.freeze({ default: captureDescriptor(direct.data), bySampleId: Object.freeze({}) });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Mock interception plan must be a descriptor or object.');
  }
  const plan = value as Readonly<MockInterceptionPlan>;
  if (Object.keys(plan).some((key) => key !== 'default' && key !== 'bySampleId')) {
    throw new TypeError('Mock interception plan contains unsupported fields.');
  }
  const defaultPlan = plan.default === undefined ? undefined : captureDescriptor(plan.default);
  if (plan.bySampleId !== undefined
      && (plan.bySampleId === null || typeof plan.bySampleId !== 'object'
        || Array.isArray(plan.bySampleId))) {
    throw new TypeError('Mock interception sample overrides must be an object.');
  }
  const overrides: Array<readonly [string, MockInterceptionDescriptor | null]> = [];
  for (const [sampleId, descriptorValue] of Object.entries(plan.bySampleId ?? {})
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    if (!sampleIds.has(sampleId)) {
      throw new TypeError('Mock interception plan references an unknown sample.');
    }
    if (descriptorValue === null) {
      if (defaultPlan !== undefined) overrides.push([sampleId, null]);
      continue;
    }
    const descriptor = captureDescriptor(descriptorValue);
    if (!sameDescriptor(defaultPlan, descriptor)) overrides.push([sampleId, descriptor]);
  }
  const bySampleId = Object.fromEntries(overrides) as Record<
    string,
    MockInterceptionDescriptor | null
  >;
  const hasEffectivePlan = [...sampleIds].some((sampleId) => (
    Object.prototype.hasOwnProperty.call(bySampleId, sampleId)
      ? bySampleId[sampleId] !== null
      : defaultPlan !== undefined
  ));
  if (!hasEffectivePlan) {
    throw new TypeError('Mock interception plan must select a descriptor for at least one sample.');
  }
  return Object.freeze({
    ...(defaultPlan === undefined ? {} : { default: defaultPlan }),
    bySampleId: deepFreezeCanonicalJson(bySampleId),
  });
}

export function captureMockInterceptionDecision(value: unknown): MockInterceptionDecision {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Mock interception provider returned an invalid decision.');
  }
  const decision = value as Readonly<Partial<MockInterceptionDecision>>;
  if (decision.decisionKind === 'pass-through'
      && Object.keys(decision).length === 1) {
    return Object.freeze({ decisionKind: 'pass-through' });
  }
  if (decision.decisionKind === 'mocked'
      && Object.keys(decision).every((key) => key === 'decisionKind' || key === 'output')
      && Object.prototype.hasOwnProperty.call(decision, 'output')) {
    return deepFreezeCanonicalJson({
      decisionKind: 'mocked',
      output: JsonValueSchema.parse(structuredClone(decision.output)),
    });
  }
  if (decision.decisionKind === 'denied'
      && Object.keys(decision).every((key) => key === 'decisionKind' || key === 'reasonCode')) {
    const reasonCode = IdentifierSchema.safeParse(decision.reasonCode);
    if (reasonCode.success) {
      return Object.freeze({ decisionKind: 'denied', reasonCode: reasonCode.data });
    }
  }
  throw new TypeError('Mock interception provider returned an invalid decision.');
}

