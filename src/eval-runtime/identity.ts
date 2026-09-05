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

function protocolSchemaIdentity(
  protocol: 'invoke' | 'session',
  role: 'input' | 'output' | 'trace',
): SchemaIdentity {
  const schemaVersion = `omk.protocol.${protocol}.${role}.json-value/v1`;
  const schemaUri = `urn:omk:protocol:${protocol}:${role}:json-value:v1`;
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

export const INVOKE_JSON_INPUT_SCHEMA = protocolSchemaIdentity('invoke', 'input');
export const INVOKE_JSON_OUTPUT_SCHEMA = protocolSchemaIdentity('invoke', 'output');
export const INVOKE_JSON_TRACE_SCHEMA = protocolSchemaIdentity('invoke', 'trace');
export const SESSION_JSON_INPUT_SCHEMA = protocolSchemaIdentity('session', 'input');
export const SESSION_JSON_OUTPUT_SCHEMA = protocolSchemaIdentity('session', 'output');
export const SESSION_JSON_TRACE_SCHEMA = protocolSchemaIdentity('session', 'trace');

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
  readonly workspace?: 'copy-on-write-overlay';
  readonly mcp?: 'native-config';
  readonly mockInterception?: 'pre-tool-call';
  readonly toolPolicy?: 'allow-list';
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

export type SessionExecutorIdentityDeclaration = InvokeExecutorIdentityDeclaration;

function createJsonExecutorIdentity(
  protocolId: 'omk.invoke/v1' | 'omk.session/v1',
  declaration: Readonly<InvokeExecutorIdentityDeclaration>,
): RuntimeIdentity {
  if (declaration.telemetry.trace === 'unsupported'
      && declaration.traceSchema !== undefined) {
    throw new TypeError('traceSchema 不能与 unsupported trace telemetry 同时声明。');
  }
  if (declaration.toolPolicy !== undefined && declaration.toolPolicy !== 'allow-list') {
    throw new TypeError('toolPolicy 只支持 allow-list。');
  }
  if (declaration.mcp !== undefined && declaration.mcp !== 'native-config') {
    throw new TypeError('mcp 只支持 native-config。');
  }
  if (declaration.mockInterception !== undefined
      && declaration.mockInterception !== 'pre-tool-call') {
    throw new TypeError('mockInterception 只支持 pre-tool-call。');
  }
  const protocol = protocolId === 'omk.invoke/v1' ? 'invoke' : 'session';
  const traceSchema = declaration.telemetry.trace === 'unsupported'
    ? undefined
    : declaration.traceSchema ?? protocolSchemaIdentity(protocol, 'trace');
  return createRuntimeIdentity({
    implementationId: declaration.implementationId,
    version: declaration.version,
    capabilities: {
      schemaVersion: EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
      protocols: [{
        protocolId,
        inputSchema: declaration.inputSchema ?? protocolSchemaIdentity(protocol, 'input'),
        outputSchema: declaration.outputSchema ?? protocolSchemaIdentity(protocol, 'output'),
        ...(traceSchema === undefined ? {} : { traceSchema }),
        execution: {
          concurrency: {
            safety: declaration.concurrency.safety,
            ...(declaration.concurrency.maxInFlight === undefined
              ? {}
              : { maxInFlight: declaration.concurrency.maxInFlight }),
          },
          cancellation: declaration.cancellation,
          state: {
            resourceLifecycle: 'per-run',
            trialState: protocolId === 'omk.session/v1' ? 'isolated' : 'stateless',
          },
          seedControl: declaration.seedControl,
          determinism: declaration.determinism,
          features: {
            systemInstructions: 'unsupported',
            workspace: declaration.workspace === undefined ? [] : [declaration.workspace],
            mcp: declaration.mcp === undefined ? [] : [declaration.mcp],
            mockInterception: declaration.mockInterception === undefined
              ? []
              : [declaration.mockInterception],
            toolPolicies: declaration.toolPolicy === undefined
              ? ['runtime-default']
              : ['allow-list', 'runtime-default'],
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

/** Builds the complete Core capability manifest for an in-process `omk.invoke/v1` executor. */
export function createInvokeExecutorIdentity(
  declaration: Readonly<InvokeExecutorIdentityDeclaration>,
): RuntimeIdentity {
  return createJsonExecutorIdentity('omk.invoke/v1', declaration);
}

/** Builds the complete Core capability manifest for an isolated `omk.session/v1` executor. */
export function createSessionExecutorIdentity(
  declaration: Readonly<SessionExecutorIdentityDeclaration>,
): RuntimeIdentity {
  return createJsonExecutorIdentity('omk.session/v1', declaration);
}
