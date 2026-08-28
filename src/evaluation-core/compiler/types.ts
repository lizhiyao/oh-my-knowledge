import { z } from 'zod';
import {
  RuntimeIdentitySchema,
  SchemaIdentitySchema,
  type ExtensionEntry,
  type JsonValue,
  type RunPlan,
} from '../contracts/index.js';

export const ProtocolManifestSchema = z.object({
  protocolId: z.enum(['omk.invoke/v1', 'omk.session/v1']),
  inputSchema: SchemaIdentitySchema,
  outputSchema: SchemaIdentitySchema,
  traceSchema: SchemaIdentitySchema.optional(),
  deterministic: z.boolean(),
}).strict();

export const ExecutorCapabilitiesSchema = z.object({
  protocols: z.array(ProtocolManifestSchema).min(1),
}).strict();

export const EvaluatorCapabilitiesSchema = z.object({
  inputSourceKinds: z.array(z.enum([
    'output',
    'trace',
    'expected',
    'evaluation-context',
  ])).min(1),
  metricValueTypes: z.array(z.enum([
    'numeric',
    'boolean',
    'categorical',
    'text',
    'ranking',
  ])).min(1),
  schemas: z.array(SchemaIdentitySchema),
}).strict();

const SamplingCapabilitiesSchema = z.object({
  experimentalUnits: z.array(z.enum(['sample', 'run', 'cluster'])).min(1),
  repeatedMeasures: z.array(z.boolean()).min(1),
  resamplingUnits: z.array(z.enum(['sample', 'paired-block', 'cluster', 'run'])).min(1),
}).strict();

const MetricObservationInputDomainSchema = z.object({
  inputKind: z.literal('metric-observations'),
  valueTypes: z.array(z.enum([
    'numeric',
    'boolean',
    'categorical',
    'text',
    'ranking',
  ])).min(1),
  missingPolicyIds: z.array(z.string().min(1).max(256)).optional(),
}).strict();

const AnalysisResultInputDomainSchema = z.object({
  inputKind: z.literal('analysis-result'),
  schemaUris: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9+.-]*:/)).min(1),
}).strict();

export const AnalysisCapabilitiesSchema = z.object({
  analysisNodeKinds: z.array(z.enum(['reducer', 'estimator', 'correction'])).min(1),
  inputDomains: z.array(z.discriminatedUnion('inputKind', [
    MetricObservationInputDomainSchema,
    AnalysisResultInputDomainSchema,
  ])),
  outputSchema: SchemaIdentitySchema,
  sampling: SamplingCapabilitiesSchema.optional(),
  schemas: z.array(SchemaIdentitySchema),
}).strict();

export const RuntimeResolutionSchema = z.object({
  identity: RuntimeIdentitySchema,
  satisfiesVersionConstraint: z.boolean(),
}).strict();

export const ExtensionImpactStageSchema = z.enum([
  'execution',
  'evaluation',
  'analysis',
  'decision',
  'run',
  'audit',
]);

export const ExtensionResolutionSchema = z.object({
  impactStage: ExtensionImpactStageSchema,
}).strict();

export type ProtocolManifest = z.infer<typeof ProtocolManifestSchema>;
export type ExecutorCapabilities = z.infer<typeof ExecutorCapabilitiesSchema>;
export type EvaluatorCapabilities = z.infer<typeof EvaluatorCapabilitiesSchema>;
export type AnalysisCapabilities = z.infer<typeof AnalysisCapabilitiesSchema>;
export type RuntimeResolution = z.infer<typeof RuntimeResolutionSchema>;
export type ExtensionImpactStage = z.infer<typeof ExtensionImpactStageSchema>;
export type ExtensionResolution = z.infer<typeof ExtensionResolutionSchema>;

export interface ExecutorRuntimeRequirement {
  referenceId: string;
  executorId: string;
  versionConstraint?: string;
  protocolId: 'omk.invoke/v1' | 'omk.session/v1';
}

export interface EvaluatorRuntimeRequirement {
  referenceId: string;
  implementationId: string;
  versionConstraint?: string;
}

export interface AnalysisRuntimeRequirement {
  referenceId: string;
  implementationId: string;
  analysisNodeKind: 'reducer' | 'estimator' | 'correction';
  requirementKind: 'analysis-node' | 'sampling-estimator';
}

export interface ExtensionValidationRequest {
  namespace: string;
  source: 'definition' | 'measurement-policy';
  entry: ExtensionEntry;
}

export interface PreparationRuntime {
  resolveExecutor(requirement: Readonly<ExecutorRuntimeRequirement>): unknown | Promise<unknown>;
  resolveEvaluator(requirement: Readonly<EvaluatorRuntimeRequirement>): unknown | Promise<unknown>;
  resolveAnalysis(requirement: Readonly<AnalysisRuntimeRequirement>): unknown | Promise<unknown>;
  validateExtension?(
    request: Readonly<ExtensionValidationRequest>,
  ): unknown | Promise<unknown>;
}

export type DeepReadonly<T> = T extends JsonValue
  ? T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type SealedRunPlan = DeepReadonly<RunPlan>;
