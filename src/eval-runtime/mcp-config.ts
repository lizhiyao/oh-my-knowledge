import {
  ExecutionResourceDescriptorSchema,
  IdentifierSchema,
  JsonValueSchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type ExecutionResourceDescriptor,
  type JsonValue,
} from '../eval-core/contracts/index.js';

export type McpConfigDescriptor = Readonly<ExecutionResourceDescriptor>;

export interface McpConfigOpenRequest {
  readonly descriptor: McpConfigDescriptor;
  readonly runId: string;
  readonly trialId: string;
  readonly sampleId: string;
  readonly variantId: string;
  readonly trialIndex: number;
  readonly trialSeed?: string;
  /** Run cancellation also bounds config materialization. */
  readonly signal: AbortSignal;
}

export interface McpConfigLease {
  /** Native JSON config visible only to the selected trial's Executor. */
  readonly config: JsonValue;
  close(): void | Promise<void>;
}

export interface McpConfigProvider {
  readonly providerId: string;
  readonly version: string;
  /** Measurement-relevant provider behavior only; credentials stay in the closure. */
  readonly fingerprintFacets?: JsonValue;
  open(request: Readonly<McpConfigOpenRequest>): Promise<McpConfigLease>;
}

export interface McpConfigAccess {
  readonly descriptor: McpConfigDescriptor;
  readonly config: JsonValue;
}

export interface McpConfigPlan {
  readonly default?: McpConfigDescriptor;
  /** `null` explicitly disables the default MCP config for one sample. */
  readonly bySampleId?: Readonly<Record<string, McpConfigDescriptor | null>>;
}

export type McpConfigInput = McpConfigDescriptor | McpConfigPlan;

export interface CapturedMcpConfigProvider {
  readonly providerId: string;
  readonly version: string;
  readonly fingerprintFacets?: JsonValue;
  open(request: Readonly<McpConfigOpenRequest>): Promise<McpConfigLease>;
}

export interface CapturedMcpConfigPlan {
  readonly default?: McpConfigDescriptor;
  readonly bySampleId: Readonly<Record<string, McpConfigDescriptor | null>>;
}

function captureDescriptor(value: unknown): McpConfigDescriptor {
  const descriptor = ExecutionResourceDescriptorSchema.parse(structuredClone(value));
  if (descriptor.mediaType !== 'application/json' || descriptor.classification !== 'secret') {
    throw new TypeError('MCP config descriptors require secret application/json content.');
  }
  return deepFreezeCanonicalJson(descriptor);
}

export function captureMcpConfigProvider(value: unknown): CapturedMcpConfigProvider | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    throw new TypeError('MCP config provider must be an object.');
  }
  const provider = value as Readonly<McpConfigProvider>;
  const providerId = IdentifierSchema.safeParse(provider.providerId);
  if (!providerId.success || typeof provider.version !== 'string' || provider.version.length === 0
      || typeof provider.open !== 'function') {
    throw new TypeError('MCP config provider declaration is invalid.');
  }
  const fingerprintFacets = provider.fingerprintFacets === undefined
    ? undefined
    : deepFreezeCanonicalJson(JsonValueSchema.parse(structuredClone(provider.fingerprintFacets)));
  const open = provider.open;
  const capturedProvider: CapturedMcpConfigProvider = {
    providerId: providerId.data,
    version: provider.version,
    ...(fingerprintFacets === undefined ? {} : { fingerprintFacets }),
    open: (request: Readonly<McpConfigOpenRequest>) => (
      Reflect.apply(open, provider, [request]) as Promise<McpConfigLease>
    ),
  };
  return Object.freeze(capturedProvider);
}

function sameDescriptor(
  left: McpConfigDescriptor | undefined,
  right: McpConfigDescriptor,
): boolean {
  return left !== undefined && canonicalizeJson(left) === canonicalizeJson(right);
}

export function captureMcpConfigPlan(
  value: unknown,
  sampleIds: ReadonlySet<string>,
): CapturedMcpConfigPlan | undefined {
  if (value === undefined) return undefined;
  const direct = ExecutionResourceDescriptorSchema.safeParse(value);
  if (direct.success) {
    return Object.freeze({ default: captureDescriptor(direct.data), bySampleId: Object.freeze({}) });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('MCP config plan must be a descriptor or object.');
  }
  const plan = value as Readonly<McpConfigPlan>;
  if (Object.keys(plan).some((key) => key !== 'default' && key !== 'bySampleId')) {
    throw new TypeError('MCP config plan contains unsupported fields.');
  }
  const defaultConfig = plan.default === undefined ? undefined : captureDescriptor(plan.default);
  if (plan.bySampleId !== undefined
      && (plan.bySampleId === null || typeof plan.bySampleId !== 'object'
        || Array.isArray(plan.bySampleId))) {
    throw new TypeError('MCP config sample overrides must be an object.');
  }
  const overrides: Array<readonly [string, McpConfigDescriptor | null]> = [];
  for (const [sampleId, config] of Object.entries(plan.bySampleId ?? {})
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    if (!sampleIds.has(sampleId)) throw new TypeError('MCP config plan references an unknown sample.');
    if (config === null) {
      if (defaultConfig !== undefined) overrides.push([sampleId, null]);
      continue;
    }
    const descriptor = captureDescriptor(config);
    if (!sameDescriptor(defaultConfig, descriptor)) overrides.push([sampleId, descriptor]);
  }
  const bySampleId = Object.fromEntries(overrides) as Record<
    string,
    McpConfigDescriptor | null
  >;
  const hasEffectiveConfig = [...sampleIds].some((sampleId) => (
    Object.prototype.hasOwnProperty.call(bySampleId, sampleId)
      ? bySampleId[sampleId] !== null
      : defaultConfig !== undefined
  ));
  if (!hasEffectiveConfig) {
    throw new TypeError('MCP config plan must select a config for at least one sample.');
  }
  return Object.freeze({
    ...(defaultConfig === undefined ? {} : { default: defaultConfig }),
    bySampleId: deepFreezeCanonicalJson(bySampleId),
  });
}

export function validateMcpConfigValue(
  descriptor: McpConfigDescriptor,
  value: unknown,
): JsonValue {
  const config = deepFreezeCanonicalJson(JsonValueSchema.parse(structuredClone(value)));
  const canonical = canonicalizeJson(config);
  if (digestCanonicalJson(config) !== descriptor.digest
      || Buffer.byteLength(canonical, 'utf8') !== descriptor.size) {
    throw new TypeError('MCP config provider returned content that does not match its descriptor.');
  }
  return config;
}
