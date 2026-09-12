import { openNodeTrialWorkspace } from '../shared/trial-workspace.js';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
  ExecutorCapabilitiesSchema,
  EffectiveExecutionControlSchema,
  IdentifierSchema,
  JsonValueSchema,
  RuntimeIdentitySchema,
  Sha256DigestSchema,
  TargetDefinitionSchema,
  UsageRecordSchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  resolveEffectiveExecutionControl,
  type EvaluationDefinition,
  type ExecutorCapabilities,
  type CoreSchemaValidator,
  type JsonValue,
  type RuntimeIdentity,
  type RuntimeImplementationFacet,
  type SchemaIdentity,
  type Sha256Digest,
  type UsageRecord,
} from '../../../../eval-core/contracts/index.js';
import {
  ExecutionPortFailure,
  type ExecutionContent,
  type ExecutionExecutor,
  type ExecutorAttemptContext,
  type ExecutorRunContext,
  type ExecutorTrialContext,
} from '../../../../eval-core/execution/index.js';
import { MOCK_INTERCEPTION_PLAN_MEDIA_TYPE } from '../../../../eval-runtime/mock-interception.js';
import {
  spawnWithSigintPropagation,
  type SpawnHelperError,
} from '../../../../executors/core/subprocess.js';
import type {
  OmkBindingResourceLease,
  OmkBindingResourceLeaseAccess,
  OmkLeasedHostResource,
} from '../../resource-leases/types.js';
import type { RuntimeBindingOf } from '../../types.js';
import {
  createSameProcessExecutorAdapter,
  type SameProcessOperationScope,
} from '../../../../eval-runtime/adapters/same-process.js';
import {
  captureClassifiedEnvironment,
  mergeOutputClassification,
  type ClassifiedEnvironmentEntry,
} from '../shared/classified-environment.js';

export const CUSTOM_EXECUTOR_EXCHANGE_SCHEMA_VERSION =
  'omk.custom-executor-exchange/v1' as const;
export const DEFAULT_CUSTOM_EXECUTOR_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function customExecutorSchemaIdentity(name: 'input' | 'output' | 'trace'): SchemaIdentity {
  const schemaVersion = `omk.custom-executor-${name}/v1`;
  return {
    schemaVersion,
    schemaUri: `urn:omk:runtime:custom-executor:${name}:v1`,
    schemaDigest: digestCanonicalJson({
      schemaVersion,
      exchangeSchemaVersion: CUSTOM_EXECUTOR_EXCHANGE_SCHEMA_VERSION,
      contract: { valueKind: 'json-value' },
    }),
  };
}

export function createCustomExecutorCoreSchemaValidators(): readonly CoreSchemaValidator[] {
  return Object.freeze((['input', 'output', 'trace'] as const).map((name) => Object.freeze({
    schema: deepFreezeCanonicalJson(customExecutorSchemaIdentity(name)),
    parse(value: unknown): JsonValue {
      return JsonValueSchema.parse(value);
    },
  })));
}

export function customExecutorCapabilities(): ExecutorCapabilities {
  return deepFreezeCanonicalJson(ExecutorCapabilitiesSchema.parse({
    schemaVersion: EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
    protocols: [{
      protocolId: 'omk.invoke/v1',
      inputSchema: customExecutorSchemaIdentity('input'),
      outputSchema: customExecutorSchemaIdentity('output'),
      traceSchema: customExecutorSchemaIdentity('trace'),
      execution: {
        concurrency: { safety: 'parallel-safe' },
        cancellation: 'best-effort',
        state: { resourceLifecycle: 'per-invocation', trialState: 'stateless' },
        seedControl: 'optional',
        determinism: 'unknown',
        features: {
          systemInstructions: 'native',
          workspace: ['copy-on-write-overlay'],
          mcp: ['native-config'],
          mockInterception: ['pre-tool-call'],
          toolPolicies: ['allow-list', 'runtime-default'],
          skillDiscovery: ['allow-list', 'disabled', 'runtime-default'],
          sandboxIds: [],
        },
        telemetry: {
          trace: 'optional',
          usage: 'optional',
          providerCost: { reporting: 'optional' },
        },
      },
    }],
  })) as ExecutorCapabilities;
}

const ExecutionContentSchema = z.object({
  value: JsonValueSchema,
  classification: z.enum(['public', 'sensitive', 'secret']),
  mediaType: z.string().min(1).optional(),
}).strict();

const CustomExecutorFailureSchema = z.object({
  code: IdentifierSchema,
  stage: z.enum(['infrastructure', 'execution']),
}).strict();

export const CustomExecutorResponseSchema = z.discriminatedUnion('resultStatus', [
  z.object({
    schemaVersion: z.literal(CUSTOM_EXECUTOR_EXCHANGE_SCHEMA_VERSION),
    resultStatus: z.literal('completed'),
    output: ExecutionContentSchema.optional(),
    trace: ExecutionContentSchema.optional(),
    usage: UsageRecordSchema.optional(),
  }).strict(),
  z.object({
    schemaVersion: z.literal(CUSTOM_EXECUTOR_EXCHANGE_SCHEMA_VERSION),
    resultStatus: z.literal('failed'),
    error: CustomExecutorFailureSchema,
    usage: UsageRecordSchema.optional(),
  }).strict(),
]);

const ResourceDescriptorSchema = z.object({
  resourceId: IdentifierSchema,
  digest: Sha256DigestSchema,
  mediaType: z.string().min(1),
  classification: z.enum(['public', 'sensitive', 'secret']),
  size: z.number().int().nonnegative(),
}).strict();

const CustomExecutorMockPlanSchema = z.object({
  schemaVersion: z.literal('omk.mock-interception-plan/v1'),
  strict: z.boolean(),
  rules: z.array(z.object({
    mockId: IdentifierSchema,
    rule: ResourceDescriptorSchema,
    payloads: z.array(ResourceDescriptorSchema),
  }).strict()).min(1),
}).strict();

const CustomExecutorImmutableResourceSchema = z.object({
    resourceId: IdentifierSchema,
    resourceKind: z.enum([
      'artifact',
      'mcp-config',
      'mock-plan',
      'mock-rule',
      'mock-payload',
      'runtime-implementation',
      'content',
    ]),
    descriptor: ResourceDescriptorSchema,
    snapshotKind: z.enum(['file', 'directory']),
    leaseMode: z.literal('immutable-snapshot'),
    snapshotPath: z.string().min(1),
  }).strict();

const CustomExecutorWorkspaceBaseSchema = z.object({
    resourceId: IdentifierSchema,
    resourceKind: z.literal('workspace'),
    descriptor: ResourceDescriptorSchema,
    snapshotKind: z.literal('directory'),
    leaseMode: z.literal('copy-on-write-overlay'),
    baseSnapshotPath: z.string().min(1),
  }).strict();

const CustomExecutorRunResourceSchema = z.discriminatedUnion('leaseMode', [
  CustomExecutorImmutableResourceSchema, CustomExecutorWorkspaceBaseSchema,
]);
type CustomExecutorRunResource = z.infer<typeof CustomExecutorRunResourceSchema>;

const CustomExecutorResourceSchema = z.discriminatedUnion('leaseMode', [
  CustomExecutorImmutableResourceSchema,
  CustomExecutorWorkspaceBaseSchema.extend({ overlayPath: z.string().min(1) }),
]).superRefine((resource, context) => {
  if (resource.resourceId !== resource.descriptor.resourceId) {
    context.addIssue({
      code: 'custom',
      path: ['descriptor', 'resourceId'],
      message: 'Resource and descriptor identities must match',
    });
  }
});

const CustomExecutorResourcesSchema = z.array(CustomExecutorResourceSchema).superRefine((
  resources,
  context,
) => {
  const ids = resources.map((resource) => resource.resourceId);
  const canonicalIds = [...new Set(ids)].sort();
  if (canonicalizeJson(ids) !== canonicalizeJson(canonicalIds)) {
    context.addIssue({
      code: 'custom',
      message: 'Resources must be unique and canonical by resourceId',
    });
  }
});

export const CustomExecutorRequestSchema = z.object({
  schemaVersion: z.literal(CUSTOM_EXECUTOR_EXCHANGE_SCHEMA_VERSION),
  isolation: z.object({
    sessionIsolationKey: z.string().min(1),
    runIsolationKey: Sha256DigestSchema,
    trialIsolationKey: Sha256DigestSchema,
  }).strict(),
  run: z.object({
    runId: z.string().min(1),
    executionPlanDigest: Sha256DigestSchema,
  }).strict(),
  trial: z.object({
    sampleId: IdentifierSchema,
    targetId: IdentifierSchema,
    executionCoordinateDigest: Sha256DigestSchema,
    executionControl: EffectiveExecutionControlSchema,
    protocolId: z.literal('omk.invoke/v1'),
    input: JsonValueSchema,
    executionContext: JsonValueSchema.optional(),
    targetConfig: JsonValueSchema.optional(),
    trialIndex: z.number().int().nonnegative(),
    trialId: Sha256DigestSchema,
    schedulingBlockId: Sha256DigestSchema,
    samplingUnitIds: z.object({
      pairingBlockId: Sha256DigestSchema.optional(),
      clusterId: Sha256DigestSchema.optional(),
      stratumId: Sha256DigestSchema.optional(),
    }).strict(),
    trialSeed: Sha256DigestSchema.optional(),
  }).strict(),
  attempt: z.object({
    attemptId: Sha256DigestSchema,
    attemptNumber: z.number().int().positive(),
  }).strict(),
  resources: CustomExecutorResourcesSchema,
}).strict();

export type CustomExecutorRequest = z.infer<typeof CustomExecutorRequestSchema>;
export type CustomExecutorResponse = z.infer<typeof CustomExecutorResponseSchema>;

export interface CustomExecutorContentIdentityFile {
  /** Stable semantic role, never a local path. */
  readonly facetId: string;
  readonly path: string;
}

export type CustomExecutorEnvironmentEntry = ClassifiedEnvironmentEntry;

export interface CustomExecutorConfiguration {
  /** Absolute executable path; PATH lookup and shell parsing are intentionally unsupported. */
  readonly executablePath: string;
  readonly arguments?: readonly string[];
  /** Complete classified child environment. Nothing is inherited from process.env. */
  readonly environment?: Readonly<Record<string, CustomExecutorEnvironmentEntry>>;
  readonly maxOutputBytes?: number;
}

export interface CustomExecutorRuntimeDescription {
  readonly implementationId: string;
  readonly version?: string;
  readonly capabilities: ExecutorCapabilities;
  /**
   * Files whose actual bytes support the identity. The adapter still reports
   * declared assurance because it cannot prove that the list is exhaustive.
   */
  readonly contentIdentityFiles?: readonly CustomExecutorContentIdentityFile[];
}

export interface CreateCustomExecutorAdapterInput {
  readonly target: EvaluationDefinition['targets'][number];
  readonly binding: RuntimeBindingOf<'executor'>;
  readonly runtime: CustomExecutorRuntimeDescription;
  readonly command: CustomExecutorConfiguration;
  readonly sessionIsolationKey: string;
  readonly resourceLeases: OmkBindingResourceLeaseAccess;
}

const CustomExecutorConfigurationSchema = z.object({
  executablePath: z.string().min(1).refine((value) => !value.includes('\0')),
  arguments: z.array(z.string().refine((value) => !value.includes('\0'))).optional(),
  environment: z.record(
    z.string().min(1).refine((value) => !value.includes('\0')),
    z.object({
      value: z.string().refine((value) => !value.includes('\0')),
      outputTaint: z.enum(['sensitive', 'secret']).optional(),
      identity: z.discriminatedUnion('identityKind', [
        z.object({
          identityKind: z.literal('behavior'),
          value: JsonValueSchema,
        }).strict(),
        z.object({ identityKind: z.literal('credential') }).strict(),
        z.object({ identityKind: z.literal('effect-locator') }).strict(),
      ]),
    }).strict(),
  ).optional(),
  maxOutputBytes: z.number().int().positive().safe().optional(),
}).strict();

interface CapturedIdentityFile {
  readonly facetId: string;
  readonly path: string;
  readonly digest: Sha256Digest;
  readonly size: number;
}

interface CapturedConfiguration {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentIdentity: JsonValue[];
  readonly environmentOutputClassification: 'public' | 'sensitive' | 'secret';
  readonly maxOutputBytes: number;
}

interface CustomExecutorRunState {
  readonly privateWorkingDirectory: string;
  readonly executablePath: string;
  readonly resources: readonly CustomExecutorRunResource[];
  readonly mockResourceIdsByPlanId: ReadonlyMap<string, ReadonlySet<string>>;
  readonly executionControls: EvaluationDefinition['targets'][number]['executionControls'];
  acquireTrial(): void;
  releaseTrial(): Promise<void>;
  requestDispose(): Promise<void>;
}

interface CustomExecutorTrialState {
  closeWorkspace(): Promise<void>;
  readonly workingDirectory: string;
  readonly resources: readonly CustomExecutorRequest['resources'][number][];
  readonly mockOutputClassification: 'public' | 'secret';
}

function sha256Bytes(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function fail(code: string, stage: 'infrastructure' | 'execution', message: string): never {
  throw new ExecutionPortFailure({ code, stage, message });
}

function captureConfiguration(input: Readonly<CustomExecutorConfiguration>): CapturedConfiguration {
  const parsed = CustomExecutorConfigurationSchema.parse(structuredClone(input));
  if (!isAbsolute(parsed.executablePath)) {
    throw new TypeError('Custom executor executablePath must be absolute.');
  }
  const maxOutputBytes = parsed.maxOutputBytes ?? DEFAULT_CUSTOM_EXECUTOR_MAX_OUTPUT_BYTES;
  const environment = captureClassifiedEnvironment(parsed.environment);
  return Object.freeze({
    executablePath: parsed.executablePath,
    arguments: Object.freeze([...(parsed.arguments ?? [])]),
    environment: environment.values,
    environmentIdentity: environment.identity,
    environmentOutputClassification: environment.outputClassification,
    maxOutputBytes,
  });
}

async function captureIdentityFiles(
  files: readonly CustomExecutorContentIdentityFile[],
): Promise<readonly CapturedIdentityFile[]> {
  const sorted = [...files].sort((left, right) => (
    left.facetId < right.facetId ? -1 : left.facetId > right.facetId ? 1 : 0
  ));
  if (new Set(sorted.map((file) => file.facetId)).size !== sorted.length) {
    throw new TypeError('Custom executor content identity facetIds must be unique.');
  }
  return Promise.all(sorted.map(async (file): Promise<CapturedIdentityFile> => {
    if (!isAbsolute(file.path)) {
      throw new TypeError(`Custom executor identity file "${file.facetId}" must use an absolute path.`);
    }
    let bytes: Uint8Array;
    try {
      bytes = await readFile(file.path);
    } catch {
      throw new TypeError(`Custom executor identity file "${file.facetId}" is unavailable.`);
    }
    return Object.freeze({
      facetId: IdentifierSchema.parse(file.facetId),
      path: file.path,
      digest: sha256Bytes(bytes),
      size: bytes.byteLength,
    });
  }));
}

function identityFacets(
  configuration: CapturedConfiguration,
  files: readonly CapturedIdentityFile[],
): RuntimeIdentity['implementationManifest'] {
  const facets: RuntimeImplementationFacet[] = [{
    facetId: 'adapter.composition',
    value: {
      exchangeSchemaVersion: CUSTOM_EXECUTOR_EXCHANGE_SCHEMA_VERSION,
      processIsolation: 'per-attempt',
      cancellation: 'sigterm-then-sigkill',
    },
  }, {
    facetId: 'command.arguments',
    value: { digest: digestCanonicalJson(configuration.arguments) },
  }, {
    facetId: 'command.environment',
    value: { entries: configuration.environmentIdentity },
  }, {
    facetId: 'command.executable',
    value: { pathDigest: digestCanonicalJson(configuration.executablePath) },
  }, {
    facetId: 'command.identity-coverage',
    value: {
      coverage: files.length === 0 ? 'none' : 'declared-files-reverified-before-spawn',
      files: files.map(({ facetId, digest, size }) => ({ facetId, digest, size })),
    },
  }, {
    facetId: 'command.output-limit',
    value: { maxOutputBytes: configuration.maxOutputBytes },
  }, {
    facetId: 'command.working-directory',
    value: { workingDirectoryKind: 'trial-private-sealed-snapshot-v2' },
  }];
  return { coverageKind: 'fingerprint-plus-facets', facets };
}

async function resolveIdentity(
  runtime: Readonly<CustomExecutorRuntimeDescription>,
  configuration: CapturedConfiguration,
): Promise<{ identity: RuntimeIdentity; files: readonly CapturedIdentityFile[] }> {
  const parsedCapabilities = ExecutorCapabilitiesSchema.parse(structuredClone(runtime.capabilities));
  if (parsedCapabilities.protocols.length !== 1
      || parsedCapabilities.protocols[0].protocolId !== 'omk.invoke/v1') {
    throw new TypeError('Custom executor Runtime supports exactly the omk.invoke/v1 protocol.');
  }
  const capabilities: ExecutorCapabilities = {
    schemaVersion: parsedCapabilities.schemaVersion,
    protocols: parsedCapabilities.protocols.map((protocol) => {
      const canonicalSet = <Value extends string>(values: readonly Value[], field: string) => {
        const sorted = [...values].sort();
        if (new Set(sorted).size !== sorted.length) {
          throw new TypeError(`Custom executor Runtime capability ${field} contains duplicates.`);
        }
        return sorted;
      };
      return {
        ...protocol,
        execution: {
          ...protocol.execution,
          features: {
            ...protocol.execution.features,
            workspace: canonicalSet(protocol.execution.features.workspace, 'workspace'),
            mcp: canonicalSet(protocol.execution.features.mcp, 'mcp'),
            mockInterception: canonicalSet(
              protocol.execution.features.mockInterception,
              'mockInterception',
            ),
            toolPolicies: canonicalSet(protocol.execution.features.toolPolicies, 'toolPolicies'),
            skillDiscovery: canonicalSet(
              protocol.execution.features.skillDiscovery,
              'skillDiscovery',
            ),
            sandboxIds: canonicalSet(protocol.execution.features.sandboxIds, 'sandboxIds'),
          },
        },
      };
    }),
  };
  for (const protocol of capabilities.protocols) {
    if (protocol.execution.cancellation !== 'best-effort') {
      throw new TypeError(
        'Custom executor Runtime capabilities must declare best-effort cancellation.',
      );
    }
    if (
      protocol.execution.state.resourceLifecycle !== 'per-invocation'
      || protocol.execution.state.trialState !== 'stateless'
    ) {
      throw new TypeError(
        'Custom executor Runtime capabilities must declare per-invocation stateless execution.',
      );
    }
  }
  const files = await captureIdentityFiles(structuredClone(runtime.contentIdentityFiles ?? []));
  const implementationId = IdentifierSchema.parse(runtime.implementationId);
  const identity = RuntimeIdentitySchema.parse({
    implementationId,
    ...(runtime.version === undefined ? {} : { version: runtime.version }),
    fingerprint: files.length === 0
      ? digestCanonicalJson({
          derivation: 'omk.custom-executor-opaque-fingerprint/v1',
          implementationId,
          capabilities,
        })
      : digestCanonicalJson({
          derivation: 'omk.custom-executor-content-fingerprint/v1',
          implementationId,
          capabilities,
          files: files.map(({ facetId, digest, size }) => ({ facetId, digest, size })),
        }),
    fingerprintBasis: files.length === 0 ? 'opaque' : 'content-derived',
    assuranceLevel: files.length === 0 ? 'unknown' : 'declared',
    capabilities,
    implementationManifest: identityFacets(configuration, files),
  });
  return {
    identity: deepFreezeCanonicalJson(identity),
    files: Object.freeze(files),
  };
}

async function assertIdentityFilesUnchanged(
  files: readonly CapturedIdentityFile[],
  signal: AbortSignal,
): Promise<void> {
  for (const file of files) {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(file.path, { signal });
    } catch {
      if (signal.aborted) {
        fail('OMK_CUSTOM_EXECUTOR_CANCELLED', 'execution', 'Custom executor execution was cancelled.');
      }
      fail(
        'OMK_CUSTOM_EXECUTOR_IDENTITY_CHANGED',
        'infrastructure',
        'Custom executor implementation identity could not be reverified.',
      );
    }
    if (bytes.byteLength !== file.size || sha256Bytes(bytes) !== file.digest) {
      fail(
        'OMK_CUSTOM_EXECUTOR_IDENTITY_CHANGED',
        'infrastructure',
        'Custom executor implementation identity changed after adapter assembly.',
      );
    }
  }
}

function projectResource(resource: OmkLeasedHostResource): CustomExecutorRunResource {
  if (resource.resourceId !== resource.descriptor.resourceId) {
    fail('OMK_CUSTOM_EXECUTOR_RESOURCE_INVALID', 'infrastructure',
      'Custom executor resource and descriptor identities must match.');
  }
  if (resource.descriptor.classification === 'gold' || resource.resourceKind === 'gold-dataset') {
    fail(
      'OMK_CUSTOM_EXECUTOR_RESOURCE_FORBIDDEN',
      'infrastructure',
      'Custom executor Executor received an analysis-only resource.',
    );
  }
  if (resource.resourceKind === 'workspace' && resource.leaseMode !== 'copy-on-write-overlay') {
    fail(
      'OMK_CUSTOM_EXECUTOR_RESOURCE_INVALID',
      'infrastructure',
      'Custom executor workspace must use a copy-on-write overlay lease.',
    );
  }
  const descriptor = {
    ...resource.descriptor,
    classification: resource.descriptor.classification,
  } as const;
  if (resource.leaseMode === 'immutable-snapshot') {
    if (resource.resourceKind === 'workspace') {
      fail(
        'OMK_CUSTOM_EXECUTOR_RESOURCE_INVALID',
        'infrastructure',
        'Custom executor workspace must use a copy-on-write overlay lease.',
      );
    }
    return {
      resourceId: resource.resourceId,
      resourceKind: resource.resourceKind,
      descriptor,
      snapshotKind: resource.snapshotKind,
      leaseMode: resource.leaseMode,
      snapshotPath: resource.snapshotPath,
    };
  }
  return {
    resourceId: resource.resourceId,
    resourceKind: 'workspace',
    descriptor,
    snapshotKind: 'directory',
    leaseMode: resource.leaseMode,
    baseSnapshotPath: resource.baseSnapshotPath,
  };
}

function isMockResource(
  resource: CustomExecutorRunResource,
): boolean {
  return resource.resourceKind === 'mock-plan'
    || resource.resourceKind === 'mock-rule'
    || resource.resourceKind === 'mock-payload';
}

async function captureMockResourceClosures(
  resources: readonly CustomExecutorRunResource[],
  executionControls: EvaluationDefinition['targets'][number]['executionControls'],
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const resourcesById = new Map(resources.map((resource) => [resource.resourceId, resource]));
  const planDescriptors = new Map<string, z.infer<typeof ResourceDescriptorSchema>>();
  const controls = [
    executionControls.defaults.mockInterception,
    ...executionControls.sampleOverrides.flatMap((override) => (
      override.mockInterception === undefined ? [] : [override.mockInterception]
    )),
  ];
  for (const control of controls) {
    if (control.mockInterceptionMode !== 'pre-tool-call') continue;
    const descriptor = ResourceDescriptorSchema.parse(control.descriptor);
    if (descriptor.mediaType !== MOCK_INTERCEPTION_PLAN_MEDIA_TYPE
        || descriptor.classification !== 'secret') {
      fail(
        'OMK_CUSTOM_EXECUTOR_MOCK_CONFIG_INVALID',
        'infrastructure',
        'Custom executor mock plan descriptor is invalid.',
      );
    }
    const existing = planDescriptors.get(descriptor.resourceId);
    if (existing !== undefined
        && canonicalizeJson(existing) !== canonicalizeJson(descriptor)) {
      fail(
        'OMK_CUSTOM_EXECUTOR_MOCK_CONFIG_INVALID',
        'infrastructure',
        'Custom executor mock plan identity is inconsistent.',
      );
    }
    planDescriptors.set(descriptor.resourceId, descriptor);
  }
  const expectedHelpers = new Map<string, {
    resourceKind: 'mock-rule' | 'mock-payload';
    descriptor: z.infer<typeof ResourceDescriptorSchema>;
  }>();
  const registerHelper = (
    resourceKind: 'mock-rule' | 'mock-payload',
    descriptor: z.infer<typeof ResourceDescriptorSchema>,
  ): void => {
    const existing = expectedHelpers.get(descriptor.resourceId);
    if (existing !== undefined && (
      existing.resourceKind !== resourceKind
      || canonicalizeJson(existing.descriptor) !== canonicalizeJson(descriptor)
    )) {
      fail(
        'OMK_CUSTOM_EXECUTOR_MOCK_CONFIG_INVALID',
        'infrastructure',
        'Custom executor mock helper identity is inconsistent.',
      );
    }
    expectedHelpers.set(descriptor.resourceId, { resourceKind, descriptor });
  };
  const closures = new Map<string, ReadonlySet<string>>();
  for (const descriptor of planDescriptors.values()) {
    const resource = resourcesById.get(descriptor.resourceId);
    if (resource?.resourceKind !== 'mock-plan'
        || resource.leaseMode !== 'immutable-snapshot'
        || resource.snapshotKind !== 'file'
        || canonicalizeJson(resource.descriptor) !== canonicalizeJson(descriptor)) {
      fail(
        'OMK_CUSTOM_EXECUTOR_MOCK_CONFIG_INVALID',
        'infrastructure',
        'Custom executor mock plan lease does not match the sealed control.',
      );
    }
    let plan: z.infer<typeof CustomExecutorMockPlanSchema>;
    try {
      plan = CustomExecutorMockPlanSchema.parse(JSON.parse(
        await readFile(resource.snapshotPath, 'utf8'),
      ) as unknown);
    } catch {
      fail(
        'OMK_CUSTOM_EXECUTOR_MOCK_CONFIG_INVALID',
        'infrastructure',
        'Custom executor mock plan is unavailable or invalid.',
      );
    }
    if (new Set(plan.rules.map((entry) => entry.mockId)).size !== plan.rules.length) {
      fail(
        'OMK_CUSTOM_EXECUTOR_MOCK_CONFIG_INVALID',
        'infrastructure',
        'Custom executor mock plan contains duplicate mock identities.',
      );
    }
    const closure = new Set<string>([descriptor.resourceId]);
    for (const entry of plan.rules) {
      const helpers = [
        { resourceKind: 'mock-rule' as const, descriptor: entry.rule },
        ...entry.payloads.map((payload) => ({
          resourceKind: 'mock-payload' as const,
          descriptor: payload,
        })),
      ];
      for (const helper of helpers) {
        if (helper.descriptor.classification !== 'secret'
            || (helper.resourceKind === 'mock-rule'
              && helper.descriptor.mediaType !== 'application/json')) {
          fail(
            'OMK_CUSTOM_EXECUTOR_MOCK_CONFIG_INVALID',
            'infrastructure',
            'Custom executor mock helper descriptor is invalid.',
          );
        }
        registerHelper(helper.resourceKind, helper.descriptor);
        const helperResource = resourcesById.get(helper.descriptor.resourceId);
        if (helperResource?.resourceKind !== helper.resourceKind
            || helperResource.leaseMode !== 'immutable-snapshot'
            || canonicalizeJson(helperResource.descriptor)
              !== canonicalizeJson(helper.descriptor)) {
          fail(
            'OMK_CUSTOM_EXECUTOR_MOCK_CONFIG_INVALID',
            'infrastructure',
            'Custom executor mock helper lease does not match the sealed plan.',
          );
        }
        closure.add(helper.descriptor.resourceId);
      }
    }
    closures.set(descriptor.resourceId, Object.freeze(closure));
  }
  const actualHelpers = resources.filter((resource) => (
    resource.resourceKind === 'mock-rule' || resource.resourceKind === 'mock-payload'
  ));
  if (actualHelpers.length !== expectedHelpers.size || actualHelpers.some((resource) => {
    const expected = expectedHelpers.get(resource.resourceId);
    return expected === undefined
      || resource.resourceKind !== expected.resourceKind
      || canonicalizeJson(resource.descriptor) !== canonicalizeJson(expected.descriptor);
  })) {
    fail(
      'OMK_CUSTOM_EXECUTOR_MOCK_CONFIG_INVALID',
      'infrastructure',
      'Custom executor mock helper leases do not match the sealed plans.',
    );
  }
  const actualPlans = resources.filter((resource) => resource.resourceKind === 'mock-plan');
  if (actualPlans.length !== planDescriptors.size) {
    fail(
      'OMK_CUSTOM_EXECUTOR_MOCK_CONFIG_INVALID',
      'infrastructure',
      'Custom executor mock plan leases do not match the sealed controls.',
    );
  }
  return closures;
}

async function captureRunState(
  lease: OmkBindingResourceLease,
  binding: RuntimeBindingOf<'executor'>,
  executionControls: EvaluationDefinition['targets'][number]['executionControls'],
): Promise<CustomExecutorRunState> {
  if (lease.bindingId !== binding.bindingId || lease.consumerKind !== 'executor') {
    fail(
      'OMK_CUSTOM_EXECUTOR_RESOURCE_FORBIDDEN',
      'infrastructure',
      'Custom executor Executor received a resource lease outside the sealed binding.',
    );
  }
  const expectedResourceIds = binding.resourceLeaseRequirements
    .map((requirement) => requirement.resourceId).sort();
  const actualResourceIds = [...lease.resourcesByResourceId.keys()].sort();
  if (canonicalizeJson(actualResourceIds) !== canonicalizeJson(expectedResourceIds)) {
    fail(
      'OMK_CUSTOM_EXECUTOR_RESOURCE_FORBIDDEN',
      'infrastructure',
      'Custom executor resource lease does not exactly cover the sealed requirements.',
    );
  }
  for (const requirement of binding.resourceLeaseRequirements) {
    const resource = lease.resourcesByResourceId.get(requirement.resourceId);
    if (resource === undefined
        || resource.resourceKind !== requirement.resourceRole
        || resource.leaseMode !== requirement.leaseMode) {
      fail(
        'OMK_CUSTOM_EXECUTOR_RESOURCE_FORBIDDEN',
        'infrastructure',
        'Custom executor resource lease role or mode differs from the sealed requirement.',
      );
    }
  }
  const resources = [...lease.resourcesByResourceId.entries()]
    .sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    ))
    .map(([resourceId, resource]) => {
      if (resourceId !== resource.resourceId) {
        fail(
          'OMK_CUSTOM_EXECUTOR_RESOURCE_INVALID',
          'infrastructure',
          'Custom executor resource lease identity is inconsistent.',
        );
      }
      return projectResource(resource);
    });
  const capturedResources = deepFreezeCanonicalJson(
    z.array(CustomExecutorRunResourceSchema).parse(resources),
  );
  const runtimeImplementations = capturedResources.filter((resource) => (
    resource.resourceKind === 'runtime-implementation'
  ));
  if (runtimeImplementations.length !== 1
      || runtimeImplementations[0]?.leaseMode !== 'immutable-snapshot'
      || runtimeImplementations[0].snapshotKind !== 'file') {
    fail(
      'OMK_CUSTOM_EXECUTOR_RUNTIME_LEASE_INVALID',
      'infrastructure',
      'Custom executor Executor requires exactly one immutable Runtime implementation lease.',
    );
  }
  const projectedResources = Object.freeze(capturedResources.filter((resource) => (
    resource.resourceKind !== 'runtime-implementation'
  )));
  const mockResourceIdsByPlanId = await captureMockResourceClosures(
    projectedResources,
    executionControls,
  );
  let privateWorkingDirectory: string;
  try {
    privateWorkingDirectory = await mkdtemp(join(tmpdir(), 'omk-custom-executor-run-'));
  } catch {
    fail(
      'OMK_CUSTOM_EXECUTOR_WORKING_DIRECTORY_CREATE_FAILED',
      'infrastructure',
      'Custom executor run working directory could not be created.',
    );
  }
  const dispose = async (): Promise<void> => {
    try {
      await rm(privateWorkingDirectory, { recursive: true, force: true });
    } catch {
      fail(
        'OMK_CUSTOM_EXECUTOR_WORKING_DIRECTORY_DISPOSE_FAILED',
        'infrastructure',
        'Custom executor run working directory could not be disposed.',
      );
    }
  };
  let activeTrials = 0;
  let disposeRequested = false;
  let disposeResult: Promise<void> | undefined;
  const startDispose = (): Promise<void> => {
    disposeResult ??= dispose();
    return disposeResult;
  };
  return Object.freeze({
    privateWorkingDirectory,
    executablePath: runtimeImplementations[0].snapshotPath,
    resources: projectedResources,
    mockResourceIdsByPlanId,
    executionControls,
    acquireTrial() {
      if (disposeRequested) {
        fail(
          'OMK_CUSTOM_EXECUTOR_RUN_DISPOSED',
          'infrastructure',
          'Custom executor run is already disposing.',
        );
      }
      activeTrials += 1;
    },
    async releaseTrial() {
      if (activeTrials <= 0) {
        fail(
          'OMK_CUSTOM_EXECUTOR_TRIAL_LIFECYCLE_INVALID',
          'infrastructure',
          'Custom executor trial lifecycle is inconsistent.',
        );
      }
      activeTrials -= 1;
      if (disposeRequested && activeTrials === 0) await startDispose();
    },
    async requestDispose() {
      disposeRequested = true;
      if (activeTrials === 0) await startDispose();
    },
  });
}

async function openCustomExecutorTrial(
  runState: CustomExecutorRunState,
  trial: Readonly<ExecutorTrialContext>,
): Promise<CustomExecutorTrialState> {
  if (canonicalizeJson(trial.executionControl) !== canonicalizeJson(
    resolveEffectiveExecutionControl(runState.executionControls, trial.sampleId),
  )) {
    fail(
      'OMK_CUSTOM_EXECUTOR_EXECUTION_CONTROL_MISMATCH',
      'infrastructure',
      'Custom executor Trial control differs from the sealed Target.',
    );
  }
  const workspace = trial.executionControl.workspace;
  const workspaceResource = workspace.workspaceMode === 'not-required'
    ? undefined
    : runState.resources.find((resource) => (
        resource.resourceKind === 'workspace'
        && resource.resourceId === workspace.descriptor.resourceId
        && canonicalizeJson(resource.descriptor) === canonicalizeJson(workspace.descriptor)
      ));
  if (workspace.workspaceMode === 'copy-on-write-overlay'
      && (workspaceResource === undefined || workspaceResource.resourceKind !== 'workspace')) {
    fail(
      'OMK_CUSTOM_EXECUTOR_WORKSPACE_LEASE_MISSING',
      'infrastructure',
      'Custom executor Trial workspace overlay lease is missing.',
    );
  }
  const mockInterception = trial.executionControl.mockInterception;
  const activeMockResourceIds = mockInterception.mockInterceptionMode === 'not-required'
    ? undefined
    : runState.mockResourceIdsByPlanId.get(mockInterception.descriptor.resourceId);
  if (mockInterception.mockInterceptionMode === 'pre-tool-call'
      && activeMockResourceIds === undefined) {
    fail(
      'OMK_CUSTOM_EXECUTOR_MOCK_CONFIG_INVALID',
      'infrastructure',
      'Custom executor Trial mock plan is absent from the sealed lease.',
    );
  }
  const trialWorkspace = await openNodeTrialWorkspace({
    parentRoot: runState.privateWorkingDirectory,
    ...(workspaceResource?.resourceKind === 'workspace'
      ? { baseSnapshotPath: workspaceResource.baseSnapshotPath } : {}),
    signal: trial.signal,
  });
  return Object.freeze({
    workingDirectory: trialWorkspace.workingDirectory,
    closeWorkspace: trialWorkspace.close,
    resources: Object.freeze(runState.resources.filter((resource) => (
      (resource.resourceKind !== 'workspace'
        || resource.resourceId === workspaceResource?.resourceId)
      && (!isMockResource(resource) || activeMockResourceIds?.has(resource.resourceId) === true)
    )).map((resource) => resource.resourceKind === 'workspace'
      ? { ...resource, overlayPath: trialWorkspace.workingDirectory } : resource)),
    mockOutputClassification: mockInterception.mockInterceptionMode === 'pre-tool-call'
      ? 'secret'
      : 'public',
  });
}

function requestDocument(
  run: Readonly<ExecutorRunContext>,
  trial: Readonly<ExecutorTrialContext>,
  attempt: Readonly<ExecutorAttemptContext>,
  scope: SameProcessOperationScope,
  trialState: CustomExecutorTrialState,
): CustomExecutorRequest {
  return CustomExecutorRequestSchema.parse({
    schemaVersion: CUSTOM_EXECUTOR_EXCHANGE_SCHEMA_VERSION,
    isolation: {
      sessionIsolationKey: scope.sessionIsolationKey,
      runIsolationKey: scope.runIsolationKey,
      trialIsolationKey: scope.operationIsolationKey,
    },
    run: {
      runId: run.runId,
      executionPlanDigest: run.executionPlanDigest,
    },
    trial: {
      sampleId: trial.sampleId,
      targetId: trial.targetId,
      executionCoordinateDigest: trial.executionCoordinateDigest,
      executionControl: trial.executionControl,
      protocolId: trial.protocolId,
      input: trial.input,
      ...(trial.executionContext === undefined ? {} : {
        executionContext: trial.executionContext,
      }),
      ...(trial.targetConfig === undefined ? {} : { targetConfig: trial.targetConfig }),
      trialIndex: trial.trialIndex,
      trialId: trial.trialId,
      schedulingBlockId: trial.schedulingBlockId,
      samplingUnitIds: trial.samplingUnitIds,
      ...(trial.trialSeed === undefined ? {} : { trialSeed: trial.trialSeed }),
    },
    attempt: {
      attemptId: attempt.attemptId,
      attemptNumber: attempt.attemptNumber,
    },
    resources: trialState.resources,
  });
}

function portFailure(error: unknown, signal: AbortSignal): never {
  const spawnError = error as SpawnHelperError;
  if (signal.aborted || spawnError.failureKind === 'abort') {
    fail('OMK_CUSTOM_EXECUTOR_CANCELLED', 'execution', 'Custom executor execution was cancelled.');
  }
  if (spawnError.failureKind === 'buffer-limit') {
    fail(
      'OMK_CUSTOM_EXECUTOR_OUTPUT_LIMIT_EXCEEDED',
      'infrastructure',
      'Custom executor output exceeded the configured byte limit.',
    );
  }
  if (spawnError.failureKind === 'nonzero-exit') {
    fail('OMK_CUSTOM_EXECUTOR_EXIT_NONZERO', 'execution', 'Custom executor process exited unsuccessfully.');
  }
  fail('OMK_CUSTOM_EXECUTOR_SPAWN_FAILED', 'infrastructure', 'Custom executor process could not run.');
}

function reportedUsage(usage: UsageRecord | undefined): UsageRecord | undefined {
  return usage !== undefined && Object.keys(usage).length > 0 ? usage : undefined;
}

async function runCommand(
  configuration: CapturedConfiguration,
  executablePath: string,
  workingDirectory: string,
  request: CustomExecutorRequest,
  signal: AbortSignal,
): Promise<CustomExecutorResponse> {
  if (signal.aborted) {
    fail('OMK_CUSTOM_EXECUTOR_CANCELLED', 'execution', 'Custom executor execution was cancelled.');
  }
  const { child, done } = spawnWithSigintPropagation(
    executablePath,
    [...configuration.arguments],
    {
      cwd: workingDirectory,
      env: { ...configuration.environment },
      maxBuffer: configuration.maxOutputBytes,
      abortSignal: signal,
    },
  );
  const input = `${canonicalizeJson(request)}\n`;
  if (child.stdin === null) {
    try { child.kill('SIGTERM'); } catch { /* process already closed */ }
    fail('OMK_CUSTOM_EXECUTOR_STDIN_UNAVAILABLE', 'infrastructure', 'Custom executor stdin is unavailable.');
  }
  const stdin = child.stdin;
  const inputDone = new Promise<void>((resolve, reject) => {
    stdin.once('error', reject);
    stdin.end(input, resolve);
  });
  let stdout: string;
  try {
    try {
      await inputDone;
    } catch (error) {
      try { child.kill('SIGTERM'); } catch { /* process already closed */ }
      const forceKill = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        } catch { /* process already closed */ }
      }, 500);
      forceKill.unref();
      try { await done; } catch { /* the stdin failure remains authoritative */ }
      clearTimeout(forceKill);
      throw error;
    }
    const result = await done;
    stdout = result.stdout;
  } catch (error) {
    portFailure(error, signal);
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    fail(
      'OMK_CUSTOM_EXECUTOR_OUTPUT_INVALID',
      'execution',
      'Custom executor returned an invalid response document.',
    );
  }
  const parsed = CustomExecutorResponseSchema.safeParse(value);
  if (!parsed.success) {
    fail(
      'OMK_CUSTOM_EXECUTOR_OUTPUT_INVALID',
      'execution',
      'Custom executor returned an invalid response document.',
    );
  }
  return parsed.data;
}

/**
 * Creates one out-of-process Core Executor binding. The adapter owns process
 * mechanics only; Core remains the sole owner of retry, timeout, budget, and cache.
 */
export async function createCustomExecutorAdapter(
  input: Readonly<CreateCustomExecutorAdapterInput>,
): Promise<ExecutionExecutor> {
  const sessionIsolationKey = input.sessionIsolationKey;
  if (typeof sessionIsolationKey !== 'string' || sessionIsolationKey.trim() === '') {
    throw new TypeError('Custom executor adapter requires a non-empty sessionIsolationKey.');
  }
  const forRun = input.resourceLeases.forRun.bind(input.resourceLeases);
  const resourceLeases = Object.freeze({ forRun });
  const target = TargetDefinitionSchema.parse(structuredClone(input.target));
  const binding = structuredClone(input.binding);
  if (binding.targetId !== target.targetId
      || binding.implementationId !== input.runtime.implementationId
      || binding.protocolId !== target.protocolId
      || binding.behaviorConfigDigest !== digestCanonicalJson(target.config ?? null)
      || binding.executionControlsDigest !== digestCanonicalJson(target.executionControls)
      || canonicalizeJson(binding.qualification.executionRequirements)
        !== canonicalizeJson(target.executionRequirements)) {
    throw new TypeError('Custom executor Target and Runtime binding are inconsistent.');
  }
  const executionControls = deepFreezeCanonicalJson(target.executionControls);
  const configuration = captureConfiguration(input.command);
  const runtime = structuredClone(input.runtime);
  const { identity, files } = await resolveIdentity(runtime, configuration);
  return createSameProcessExecutorAdapter({
    identity,
    sessionIsolationKey,
    resourceLeases,
    implementation: {
      openRun({ resources }) {
        return captureRunState(resources, binding, executionControls);
      },
      async openTrial({ runState, trial }) {
        runState.acquireTrial();
        try {
          return await openCustomExecutorTrial(runState, trial);
        } catch (error) {
          await runState.releaseTrial();
          throw error;
        }
      },
      async execute({ run, runState, trial, trialState, attempt, scope }) {
        if (attempt.signal.aborted) {
          fail('OMK_CUSTOM_EXECUTOR_CANCELLED', 'execution', 'Custom executor execution was cancelled.');
        }
        await assertIdentityFilesUnchanged(files, attempt.signal);
        const response = await runCommand(
          configuration,
          runState.executablePath,
          trialState.workingDirectory,
          requestDocument(run, trial, attempt, scope, trialState),
          attempt.signal,
        );
        if (response.resultStatus === 'failed') {
          const usage = reportedUsage(response.usage);
          throw new ExecutionPortFailure({
            code: response.error.code,
            stage: response.error.stage,
            message: 'Custom executor Runtime reported a structured failure.',
          }, usage);
        }
        const usage = reportedUsage(response.usage);
        return {
          ...(response.output === undefined ? {} : {
            output: {
              ...response.output,
              classification: mergeOutputClassification(
                response.output.classification,
                mergeOutputClassification(
                  configuration.environmentOutputClassification,
                  trialState.mockOutputClassification,
                ),
              ),
            } as ExecutionContent,
          }),
          ...(response.trace === undefined ? {} : {
            trace: {
              ...response.trace,
              classification: mergeOutputClassification(
                response.trace.classification,
                mergeOutputClassification(
                  configuration.environmentOutputClassification,
                  trialState.mockOutputClassification,
                ),
              ),
            } as ExecutionContent,
          }),
          ...(usage === undefined ? {} : { usage }),
        };
      },
      async disposeTrial({ runState, trialState }) {
        try {
          await trialState.closeWorkspace();
        } finally {
          await runState.releaseTrial();
        }
      },
      disposeRun({ runState }) {
        return runState.requestDispose();
      },
    },
  });
}
