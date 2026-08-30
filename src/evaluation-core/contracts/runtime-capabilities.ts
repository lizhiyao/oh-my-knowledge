import { z } from 'zod';
import { IdentifierSchema, SchemaIdentitySchema } from './common.js';

export const EXECUTOR_CAPABILITIES_SCHEMA_VERSION =
  'omk.executor-capabilities/v1' as const;

export const ProtocolManifestSchema = z.object({
  protocolId: z.enum(['omk.invoke/v1', 'omk.session/v1']),
  inputSchema: SchemaIdentitySchema,
  outputSchema: SchemaIdentitySchema,
  traceSchema: SchemaIdentitySchema.optional(),
  execution: z.object({
    concurrency: z.object({
      safety: z.enum(['serialized', 'parallel-safe']),
      maxInFlight: z.number().int().positive().optional(),
    }).strict(),
    cancellation: z.enum(['cooperative', 'best-effort', 'unsupported']),
    state: z.object({
      resourceLifecycle: z.enum(['per-invocation', 'per-run']),
      trialState: z.enum(['stateless', 'isolated']),
    }).strict(),
    seedControl: z.enum(['unsupported', 'optional', 'required']),
    determinism: z.enum(['deterministic', 'stochastic', 'unknown']),
    features: z.object({
      systemInstructions: z.enum(['native', 'prepended', 'unsupported']),
      workspace: z.array(z.literal('copy-on-write-overlay')),
      mcp: z.array(z.literal('native-config')),
      mockInterception: z.array(z.literal('pre-tool-call')),
      toolPolicies: z.array(z.enum(['runtime-default', 'allow-list'])),
      skillDiscovery: z.array(z.enum(['runtime-default', 'disabled', 'allow-list'])),
      sandboxIds: z.array(IdentifierSchema),
    }).strict(),
    telemetry: z.object({
      trace: z.enum(['unsupported', 'optional', 'required']),
      usage: z.enum(['unsupported', 'optional', 'required']),
      providerCost: z.object({
        reporting: z.enum(['unsupported', 'optional', 'required']),
        trustedUpperBound: z.object({
          amount: z.number().nonnegative(),
          currency: z.string().regex(/^[A-Z]{3}$/),
        }).strict().optional(),
      }).strict().refine(
        (value) => value.trustedUpperBound === undefined || value.reporting === 'required',
        { message: 'A trusted provider-cost bound requires required reporting.' },
      ).optional(),
    }).strict(),
  }).strict(),
}).strict();

export const ExecutorCapabilitiesSchema = z.object({
  schemaVersion: z.literal(EXECUTOR_CAPABILITIES_SCHEMA_VERSION),
  protocols: z.array(ProtocolManifestSchema).min(1),
}).strict().meta({
  title: 'OMK Executor Capabilities v1',
});

export type ProtocolManifest = z.infer<typeof ProtocolManifestSchema>;
export type ExecutorCapabilities = z.infer<typeof ExecutorCapabilitiesSchema>;
