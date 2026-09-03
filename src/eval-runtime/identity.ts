import {
  EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
  RuntimeIdentitySchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
  type SchemaIdentity,
} from '../eval-core/contracts/index.js';

export interface RuntimeIdentityDeclaration {
  readonly implementationId: string;
  readonly version: string;
  readonly capabilities: JsonValue;
  readonly fingerprintFacets?: JsonValue;
}

/**
 * Produces a validated, immutable Runtime identity from measurement-relevant declarations.
 * The helper does not claim code verification: callers must opt into stronger provenance.
 */
export function createRuntimeIdentity(
  declaration: Readonly<RuntimeIdentityDeclaration>,
): RuntimeIdentity {
  const captured = structuredClone(declaration);
  const fingerprint = digestCanonicalJson({
    derivation: 'omk.eval-runtime.identity/v1',
    implementationId: captured.implementationId,
    version: captured.version,
    capabilities: captured.capabilities,
    ...(captured.fingerprintFacets === undefined
      ? {}
      : { fingerprintFacets: captured.fingerprintFacets }),
  });
  return deepFreezeCanonicalJson(RuntimeIdentitySchema.parse({
    implementationId: captured.implementationId,
    version: captured.version,
    fingerprint,
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: captured.capabilities,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }));
}

function protocolSchemaIdentity(role: 'input' | 'output' | 'trace'): SchemaIdentity {
  const schemaVersion = `omk.protocol.invoke.${role}.json-value/v1`;
  const schemaUri = `urn:omk:protocol:invoke:${role}:json-value:v1`;
  return Object.freeze({
    schemaVersion,
    schemaUri,
    schemaDigest: digestCanonicalJson({
      schemaVersion,
      schemaUri,
      valueDomain: 'json-value',
    }),
  });
}

export const INVOKE_JSON_INPUT_SCHEMA = protocolSchemaIdentity('input');
export const INVOKE_JSON_OUTPUT_SCHEMA = protocolSchemaIdentity('output');
export const INVOKE_JSON_TRACE_SCHEMA = protocolSchemaIdentity('trace');

export interface InvokeExecutorIdentityDeclaration {
  readonly implementationId: string;
  readonly version: string;
  readonly determinism: 'deterministic' | 'stochastic' | 'unknown';
  readonly cancellation: 'cooperative' | 'best-effort' | 'unsupported';
  readonly concurrency: Readonly<{
    safety: 'serialized' | 'parallel-safe';
    maxInFlight?: number;
  }>;
  readonly seedControl: 'unsupported' | 'optional' | 'required';
  readonly telemetry: Readonly<{
    trace: 'unsupported' | 'optional' | 'required';
    usage: 'unsupported' | 'optional' | 'required';
    providerCost?: Readonly<{
      reporting: 'unsupported' | 'optional' | 'required';
      trustedUpperBound?: Readonly<{ amount: number; currency: string }>;
    }>;
  }>;
  readonly inputSchema?: SchemaIdentity;
  readonly outputSchema?: SchemaIdentity;
  readonly traceSchema?: SchemaIdentity;
  /** Deployment or implementation facets that distinguish measurement-relevant revisions. */
  readonly fingerprintFacets: JsonValue;
}

/** Builds the complete Core capability manifest for an in-process `omk.invoke/v1` executor. */
export function createInvokeExecutorIdentity(
  declaration: Readonly<InvokeExecutorIdentityDeclaration>,
): RuntimeIdentity {
  if (declaration.telemetry.trace === 'unsupported'
      && declaration.traceSchema !== undefined) {
    throw new TypeError('traceSchema 不能与 unsupported trace telemetry 同时声明。');
  }
  const traceSchema = declaration.telemetry.trace === 'unsupported'
    ? undefined
    : declaration.traceSchema ?? INVOKE_JSON_TRACE_SCHEMA;
  return createRuntimeIdentity({
    implementationId: declaration.implementationId,
    version: declaration.version,
    capabilities: {
      schemaVersion: EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
      protocols: [{
        protocolId: 'omk.invoke/v1',
        inputSchema: declaration.inputSchema ?? INVOKE_JSON_INPUT_SCHEMA,
        outputSchema: declaration.outputSchema ?? INVOKE_JSON_OUTPUT_SCHEMA,
        ...(traceSchema === undefined ? {} : { traceSchema }),
        execution: {
          concurrency: {
            safety: declaration.concurrency.safety,
            ...(declaration.concurrency.maxInFlight === undefined
              ? {}
              : { maxInFlight: declaration.concurrency.maxInFlight }),
          },
          cancellation: declaration.cancellation,
          state: { resourceLifecycle: 'per-run', trialState: 'stateless' },
          seedControl: declaration.seedControl,
          determinism: declaration.determinism,
          features: {
            systemInstructions: 'unsupported',
            workspace: [],
            mcp: [],
            mockInterception: [],
            toolPolicies: ['runtime-default'],
            skillDiscovery: ['runtime-default'],
            sandboxIds: [],
          },
          telemetry: declaration.telemetry,
        },
      }],
    },
    fingerprintFacets: declaration.fingerprintFacets,
  });
}
