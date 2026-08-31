import {
  EvaluationDefinitionSchema,
  IdentifierSchema,
  MeasurementPolicySchema,
  SchemaIdentitySchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  prepareEvaluationSeriesPlan,
  schemaIdentityKey,
  type CoreSchemaValidator,
  type JsonValue,
} from '../../evaluation-core/contracts/index.js';
import { createBuiltinAnalysisSchemaValidators } from '../../evaluation-core/analysis/index.js';
import { createJudgeAggregationSchemaValidators } from './analysis/judge-aggregation.js';
import { createAssertionLayerParameterSchemaValidators } from './analysis/assertion-layer-parameters.js';
import { createAssertionLayerTableSchemaValidators } from './analysis/assertion-layer.js';
import { createDimensionParameterSchemaValidators } from './analysis/dimension-parameters.js';
import { createDimensionTableSchemaValidators } from './analysis/dimension-table.js';
import type { SealedRunPlan } from '../../evaluation-core/compiler/index.js';
import {
  createEvaluationEngine,
  type EvaluationEngineClock,
  type EvaluationEngineEventWriter,
  type EvaluationRun,
  type PreparedEvaluation,
} from '../../evaluation-core/engine/index.js';
import type {
  EvaluationCache,
  EvaluationContentResolver,
  EvaluationContentStore,
} from '../../evaluation-core/evaluation/index.js';
import type {
  ExecutionCache,
  ExecutionContentStore,
} from '../../evaluation-core/execution/index.js';
import type {
  CliEvaluationCompileResult,
  ResolvedHostResources,
} from '../input-compilation/index.js';
import { assembleOmkRuntimeBindings } from './assembly.js';
import {
  createBuiltinOmkAnalysisBindingFactories,
  createBuiltinOmkScoringBindingFactories,
} from './builtins.js';
import {
  OmkResourceLeaseError,
  materializeNodeRunResourceLeases,
  resourceLeaseRequestsFromBindingEntries,
  type MaterializeNodeRunResourceLeasesInput,
  type OmkAnalysisOnlyResourceLeaseRequest,
  type OmkBindingResourceLease,
  type OmkLeasedHostResource,
  type OmkPinnedGitVerifier,
  type OmkResourceLeaseLimits,
  type OmkRunResourceLeases,
} from './resource-leases/index.js';
import type {
  OmkEvaluationSeriesRuntimeBindingAssembly,
  OmkRuntimeBindingFactories,
} from './types.js';
import {
  runOmkEvaluationPreflight,
  type OmkEvaluationPreflightOptions,
  type OmkEvaluationPreflightResult,
} from './preflight.js';
import {
  attachOmkEvaluationProgressProjection,
  captureOmkEvaluationProgressProjection,
  type CapturedOmkEvaluationProgressProjection,
  type OmkEvaluationProgressSink,
} from './event-projection.js';

export interface OmkCachePortBinding<Port> {
  readonly sourceLocator: string;
  readonly port: Port;
}

export interface OmkEvaluationEventWriterContext {
  readonly runId: string;
  readonly plan: SealedRunPlan;
}

export type OmkEvaluationEventWriterFactory = (
  context: Readonly<OmkEvaluationEventWriterContext>,
) => EvaluationEngineEventWriter | Promise<EvaluationEngineEventWriter>;

export interface OmkEvaluationRuntimeSupportPorts {
  readonly clock: EvaluationEngineClock;
  /** Host validators only; Core-owned built-ins are merged by the composition root. */
  readonly schemaValidators?: ReadonlyMap<string, CoreSchemaValidator>;
  readonly executionCache?: OmkCachePortBinding<ExecutionCache>;
  readonly evaluationCache?: OmkCachePortBinding<EvaluationCache>;
  readonly executionContentStore?: ExecutionContentStore;
  readonly evaluationContentStore?: EvaluationContentStore;
  readonly contentResolver?: EvaluationContentResolver;
  readonly createEventWriter?: OmkEvaluationEventWriterFactory;
}

export type OmkRunResourceLeaseMaterializer = (
  input: Readonly<MaterializeNodeRunResourceLeasesInput>,
) => Promise<OmkRunResourceLeases>;

export interface OmkEvaluationRuntimeResourceOptions {
  readonly leaseRoot: string;
  readonly limits?: Partial<OmkResourceLeaseLimits>;
  readonly pinnedGitVerifier?: OmkPinnedGitVerifier;
  /** Platform host boundary; Node snapshot／overlay materialization is the default. */
  readonly materialize?: OmkRunResourceLeaseMaterializer;
}

export interface CreateOmkEvaluationRuntimeInput {
  readonly compiled: CliEvaluationCompileResult;
  readonly factories: OmkRuntimeBindingFactories;
  readonly support: OmkEvaluationRuntimeSupportPorts;
  readonly resources: OmkEvaluationRuntimeResourceOptions;
}

export interface OmkEvaluationRunOptions {
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly eventBufferCapacity?: number;
  readonly progressSink?: OmkEvaluationProgressSink;
  readonly progressBufferCapacity?: number;
}

export interface OmkPreparedEvaluation {
  readonly plan: SealedRunPlan;
  /** Host-only physical readiness evidence; it does not enter or modify the Core Plan. */
  readonly preflight: OmkEvaluationPreflightResult;
  start(options: Readonly<OmkEvaluationRunOptions>): Promise<EvaluationRun>;
}

export interface OmkEvaluationRuntime {
  prepare(options?: Readonly<OmkEvaluationPreflightOptions>): Promise<OmkPreparedEvaluation>;
  readonly series?: OmkEvaluationSeriesRuntimeBindingAssembly;
}

interface CapturedResourceOptions {
  readonly leaseRoot: string;
  readonly limits?: Readonly<Partial<OmkResourceLeaseLimits>>;
  readonly pinnedGitVerifier?: OmkPinnedGitVerifier;
  readonly materialize: OmkRunResourceLeaseMaterializer;
}

export type OmkEvaluationRuntimeErrorCode =
  | 'OMK_EVALUATION_RUNTIME_INPUT_INVALID'
  | 'OMK_EVALUATION_RUNTIME_FACTORY_CONFLICT'
  | 'OMK_EVALUATION_RUNTIME_SUPPORT_PORT_REQUIRED'
  | 'OMK_EVALUATION_RUNTIME_SUPPORT_PORT_INVALID'
  | 'OMK_EVALUATION_RUNTIME_CACHE_SOURCE_MISMATCH'
  | 'OMK_EVALUATION_RUNTIME_SCHEMA_VALIDATOR_CONFLICT'
  | 'OMK_EVALUATION_RUNTIME_RUN_ACTIVE'
  | 'OMK_EVALUATION_RUNTIME_RUN_ABORTED_BEFORE_START'
  | 'OMK_EVALUATION_RUNTIME_RESOURCE_LEASE_FAILED'
  | 'OMK_EVALUATION_RUNTIME_RESOURCE_LEASE_INVALID'
  | 'OMK_EVALUATION_RUNTIME_EVENT_WRITER_FAILED'
  | 'OMK_EVALUATION_RUNTIME_START_FAILED'
  | 'OMK_EVALUATION_RUNTIME_CLEANUP_FAILED';

export class OmkEvaluationRuntimeError extends Error {
  readonly code: OmkEvaluationRuntimeErrorCode;
  readonly fieldPath?: string;
  readonly runId?: string;

  constructor(input: {
    code: OmkEvaluationRuntimeErrorCode;
    message: string;
    fieldPath?: string;
    runId?: string;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'OmkEvaluationRuntimeError';
    this.code = input.code;
    this.fieldPath = input.fieldPath;
    this.runId = input.runId;
  }
}

function fail(input: ConstructorParameters<typeof OmkEvaluationRuntimeError>[0]): never {
  throw new OmkEvaluationRuntimeError(input);
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function boundMethod(
  port: Readonly<Record<string, unknown>>,
  methodName: string,
): (...args: never[]) => unknown {
  const method = port[methodName] as (...args: never[]) => unknown;
  return (...args: never[]) => Reflect.apply(method, port, args);
}

function capturePort<Port>(
  candidate: Port,
  methods: readonly string[],
  fieldPath: string,
): Port {
  const port = record(candidate);
  if (port === undefined || methods.some((method) => typeof port[method] !== 'function')) fail({
    code: 'OMK_EVALUATION_RUNTIME_SUPPORT_PORT_INVALID',
    fieldPath,
    message: `${fieldPath} 不符合 Core support port contract。`,
  });
  return Object.freeze(Object.fromEntries(methods.map((method) => [
    method,
    boundMethod(port, method),
  ]))) as Port;
}

function readonlyMapSnapshot<Key, Value>(source: ReadonlyMap<Key, Value>): ReadonlyMap<Key, Value> {
  const snapshot = new Map(source);
  const view: ReadonlyMap<Key, Value> = Object.freeze({
    get size() { return snapshot.size; },
    get(key: Key) { return snapshot.get(key); },
    has(key: Key) { return snapshot.has(key); },
    keys() { return snapshot.keys(); },
    values() { return snapshot.values(); },
    entries() { return snapshot.entries(); },
    [Symbol.iterator]() { return snapshot[Symbol.iterator](); },
    forEach(
      callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
      thisArg?: unknown,
    ) {
      snapshot.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
  });
  return view;
}

function snapshotCompiled(input: CliEvaluationCompileResult): CliEvaluationCompileResult {
  let snapshot: CliEvaluationCompileResult;
  try {
    snapshot = deepFreezeCanonicalJson(
      structuredClone(input) as unknown as JsonValue,
    ) as unknown as CliEvaluationCompileResult;
  } catch (cause) {
    return fail({
      code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
      message: 'Compiled evaluation input 无法建立规范化不可变快照。',
      cause,
    });
  }
  const definition = EvaluationDefinitionSchema.safeParse(snapshot.definition);
  const policy = MeasurementPolicySchema.safeParse(snapshot.policy);
  if (!definition.success || !policy.success
      || digestCanonicalJson(snapshot.definition) !== snapshot.canonicalDigests.definition
      || digestCanonicalJson(snapshot.policy) !== snapshot.canonicalDigests.policy) fail({
    code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
    message: 'Compiled evaluation input 的 Core schema 或 canonical digest 不一致。',
  });
  return snapshot;
}

function captureResourceOptions(
  input: OmkEvaluationRuntimeResourceOptions,
): CapturedResourceOptions {
  if (record(input) === undefined || typeof input.leaseRoot !== 'string'
      || input.leaseRoot === ''
      || (input.materialize !== undefined && typeof input.materialize !== 'function')) fail({
    code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
    fieldPath: 'resources',
    message: 'Resource lease options 不合法。',
  });
  let limits: Readonly<Partial<OmkResourceLeaseLimits>> | undefined;
  try {
    limits = input.limits === undefined
      ? undefined
      : Object.freeze(structuredClone(input.limits));
  } catch (cause) {
    return fail({
      code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
      fieldPath: 'resources.limits',
      message: 'Resource lease limits 无法建立不可变快照。',
      cause,
    });
  }
  if (limits !== undefined && Object.values(limits).some((value) => (
    value !== undefined && (!Number.isSafeInteger(value) || value <= 0)
  ))) fail({
    code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
    fieldPath: 'resources.limits',
    message: 'Resource lease limits 必须是正安全整数。',
  });
  let pinnedGitVerifier: OmkPinnedGitVerifier | undefined;
  if (input.pinnedGitVerifier !== undefined) {
    const verifier = record(input.pinnedGitVerifier);
    if (typeof verifier?.verifyPinnedCommit !== 'function') fail({
      code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
      fieldPath: 'resources.pinnedGitVerifier',
      message: 'Pinned Git verifier 不符合 port contract。',
    });
    pinnedGitVerifier = Object.freeze({
      verifyPinnedCommit: boundMethod(
        verifier,
        'verifyPinnedCommit',
      ) as OmkPinnedGitVerifier['verifyPinnedCommit'],
    });
  }
  const owner = input as unknown as Readonly<Record<string, unknown>>;
  const materialize = input.materialize === undefined
    ? materializeNodeRunResourceLeases
    : boundMethod(owner, 'materialize') as OmkRunResourceLeaseMaterializer;
  return Object.freeze({
    leaseRoot: input.leaseRoot,
    ...(limits === undefined ? {} : { limits }),
    ...(pinnedGitVerifier === undefined ? {} : { pinnedGitVerifier }),
    materialize,
  });
}

function captureClock(clock: EvaluationEngineClock): EvaluationEngineClock {
  return capturePort(clock, ['monotonicNow', 'timestamp', 'sleep'], 'support.clock');
}

function captureSchemaValidators(
  hostValidators: ReadonlyMap<string, CoreSchemaValidator> | undefined,
): ReadonlyMap<string, CoreSchemaValidator> {
  let hostEntries: Array<[string, CoreSchemaValidator]>;
  try {
    hostEntries = [...(hostValidators ?? new Map())];
  } catch (cause) {
    return fail({
      code: 'OMK_EVALUATION_RUNTIME_SUPPORT_PORT_INVALID',
      fieldPath: 'support.schemaValidators',
      message: 'Host SchemaValidator registry 不是可迭代 map。',
      cause,
    });
  }
  const candidates: Array<readonly [string, CoreSchemaValidator, 'builtin' | 'host']> = [
    ...[...createBuiltinAnalysisSchemaValidators()].map((entry) => (
      [entry[0], entry[1], 'builtin'] as const
    )),
    ...[...createAssertionLayerParameterSchemaValidators()].map((entry) => (
      [entry[0], entry[1], 'builtin'] as const
    )),
    ...[...createAssertionLayerTableSchemaValidators()].map((entry) => (
      [entry[0], entry[1], 'builtin'] as const
    )),
    ...[...createJudgeAggregationSchemaValidators()].map((entry) => (
      [entry[0], entry[1], 'builtin'] as const
    )),
    ...[...createDimensionParameterSchemaValidators()].map((entry) => (
      [entry[0], entry[1], 'builtin'] as const
    )),
    ...[...createDimensionTableSchemaValidators()].map((entry) => (
      [entry[0], entry[1], 'builtin'] as const
    )),
    ...hostEntries.map((entry) => (
      [entry[0], entry[1], 'host'] as const
    )),
  ];
  const validators = new Map<string, CoreSchemaValidator>();
  const byUri = new Map<string, { identity: string; validator: CoreSchemaValidator }>();
  for (const [key, validator, source] of candidates) {
    const candidate = record(validator);
    const parsed = SchemaIdentitySchema.safeParse(candidate?.schema);
    if (!parsed.success) fail({
      code: 'OMK_EVALUATION_RUNTIME_SUPPORT_PORT_INVALID',
      fieldPath: 'support.schemaValidators',
      message: `${source} SchemaValidator 的 schema identity 不合法。`,
    });
    if (typeof candidate?.parse !== 'function' || key !== schemaIdentityKey(parsed.data)) fail({
      code: 'OMK_EVALUATION_RUNTIME_SUPPORT_PORT_INVALID',
      fieldPath: 'support.schemaValidators',
      message: `${source} SchemaValidator 的 key 或 parse contract 不合法。`,
    });
    const identity = canonicalizeJson(parsed.data);
    const existingByUri = byUri.get(parsed.data.schemaUri);
    const existingByKey = validators.get(key);
    if ((existingByUri !== undefined
          && (existingByUri.identity !== identity || existingByUri.validator !== validator))
        || (existingByKey !== undefined && existingByKey !== validator)) fail({
      code: 'OMK_EVALUATION_RUNTIME_SCHEMA_VALIDATOR_CONFLICT',
      fieldPath: 'support.schemaValidators',
      message: `Schema URI "${parsed.data.schemaUri}" 存在 identity 或 validator 冲突。`,
    });
    if (existingByKey !== undefined) continue;
    const captured: CoreSchemaValidator = Object.freeze({
      schema: deepFreezeCanonicalJson(parsed.data),
      parse: boundMethod(candidate, 'parse') as CoreSchemaValidator['parse'],
    });
    validators.set(key, captured);
    byUri.set(parsed.data.schemaUri, { identity, validator });
  }
  return readonlyMapSnapshot(validators);
}

function captureCachePort<Port>(input: {
  binding: OmkCachePortBinding<Port> | undefined;
  expectedSource: string | undefined;
  enabled: boolean;
  fieldPath: string;
}): Port | undefined {
  if (!input.enabled) {
    if (input.binding !== undefined) fail({
      code: 'OMK_EVALUATION_RUNTIME_CACHE_SOURCE_MISMATCH',
      fieldPath: input.fieldPath,
      message: `${input.fieldPath} 在 sealed cache policy 为 disabled 时不得注入。`,
    });
    return undefined;
  }
  if (input.binding === undefined) fail({
    code: 'OMK_EVALUATION_RUNTIME_SUPPORT_PORT_REQUIRED',
    fieldPath: input.fieldPath,
    message: `${input.fieldPath} 是 sealed cache policy 的必需 port。`,
  });
  const binding = record(input.binding);
  if (binding === undefined || input.expectedSource === undefined
      || binding.sourceLocator !== input.expectedSource) fail({
    code: 'OMK_EVALUATION_RUNTIME_CACHE_SOURCE_MISMATCH',
    fieldPath: `${input.fieldPath}.sourceLocator`,
    message: `${input.fieldPath} 未绑定 compiled orchestration 声明的 cache source。`,
  });
  return capturePort(binding.port as Port, ['get', 'put'], `${input.fieldPath}.port`);
}

function requiredPort<Port>(input: {
  candidate: Port | undefined;
  required: boolean;
  fieldPath: string;
  methods: readonly string[];
}): Port | undefined {
  if (input.candidate === undefined) {
    if (input.required) fail({
      code: 'OMK_EVALUATION_RUNTIME_SUPPORT_PORT_REQUIRED',
      fieldPath: input.fieldPath,
      message: `${input.fieldPath} 是 sealed MeasurementPolicy 的必需 port。`,
    });
    return undefined;
  }
  return capturePort(input.candidate, input.methods, input.fieldPath);
}

function mergeFactoryMap<Factory>(
  builtin: ReadonlyMap<string, Factory>,
  host: ReadonlyMap<string, Factory>,
  fieldPath: string,
): ReadonlyMap<string, Factory> {
  const merged = new Map(builtin);
  for (const [implementationId, factory] of host) {
    if (merged.has(implementationId)) fail({
      code: 'OMK_EVALUATION_RUNTIME_FACTORY_CONFLICT',
      fieldPath,
      message: `implementationId "${implementationId}" 与 OMK built-in factory 冲突。`,
    });
    merged.set(implementationId, factory);
  }
  return readonlyMapSnapshot(merged);
}

function captureFactoryMap<Factory>(
  source: ReadonlyMap<string, Factory>,
  fieldPath: string,
): ReadonlyMap<string, Factory> {
  let entries: Array<[string, Factory]>;
  try {
    entries = [...source];
  } catch (cause) {
    return fail({
      code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
      fieldPath,
      message: `${fieldPath} 不是可迭代的 factory map。`,
      cause,
    });
  }
  if (entries.some(([implementationId, factory]) => (
    implementationId === '' || typeof factory !== 'function'
  ))) fail({
    code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
    fieldPath,
    message: `${fieldPath} 包含不合法 implementationId 或 factory。`,
  });
  return readonlyMapSnapshot(new Map(entries));
}

function withBuiltinFactories(
  host: OmkRuntimeBindingFactories,
): OmkRuntimeBindingFactories {
  if (record(host) === undefined) fail({
    code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
    fieldPath: 'factories',
    message: 'Runtime binding factories 不合法。',
  });
  const captured = {
    executorsByImplementationId: captureFactoryMap(
      host.executorsByImplementationId,
      'factories.executorsByImplementationId',
    ),
    evaluatorsByImplementationId: captureFactoryMap(
      host.evaluatorsByImplementationId,
      'factories.evaluatorsByImplementationId',
    ),
    analysisNodesByImplementationId: captureFactoryMap(
      host.analysisNodesByImplementationId,
      'factories.analysisNodesByImplementationId',
    ),
    missingPoliciesByImplementationId: captureFactoryMap(
      host.missingPoliciesByImplementationId,
      'factories.missingPoliciesByImplementationId',
    ),
    decisionPoliciesByImplementationId: captureFactoryMap(
      host.decisionPoliciesByImplementationId,
      'factories.decisionPoliciesByImplementationId',
    ),
    seriesAnalysisNodesByImplementationId: captureFactoryMap(
      host.seriesAnalysisNodesByImplementationId,
      'factories.seriesAnalysisNodesByImplementationId',
    ),
    seriesDecisionPoliciesByImplementationId: captureFactoryMap(
      host.seriesDecisionPoliciesByImplementationId,
      'factories.seriesDecisionPoliciesByImplementationId',
    ),
  };
  const analysisBuiltin = createBuiltinOmkAnalysisBindingFactories();
  const scoringBuiltin = createBuiltinOmkScoringBindingFactories();
  return Object.freeze({
    ...captured,
    evaluatorsByImplementationId: mergeFactoryMap(
      scoringBuiltin.evaluatorsByImplementationId,
      captured.evaluatorsByImplementationId,
      'factories.evaluatorsByImplementationId',
    ),
    analysisNodesByImplementationId: mergeFactoryMap(
      analysisBuiltin.analysisNodesByImplementationId,
      captured.analysisNodesByImplementationId,
      'factories.analysisNodesByImplementationId',
    ),
    missingPoliciesByImplementationId: mergeFactoryMap(
      analysisBuiltin.missingPoliciesByImplementationId,
      captured.missingPoliciesByImplementationId,
      'factories.missingPoliciesByImplementationId',
    ),
    decisionPoliciesByImplementationId: mergeFactoryMap(
      analysisBuiltin.decisionPoliciesByImplementationId,
      captured.decisionPoliciesByImplementationId,
      'factories.decisionPoliciesByImplementationId',
    ),
  });
}

function evaluatorNeedsReferenceResolver(compiled: CliEvaluationCompileResult): boolean {
  const outputReference = compiled.policy.evidence.output === 'reference';
  const traceReference = compiled.policy.evidence.trace === 'reference';
  return compiled.definition.evaluators.some((evaluator) => evaluator.inputs.some((input) => (
    (input.sourceKind === 'output' && outputReference)
    || (input.sourceKind === 'trace' && traceReference)
  )));
}

function captureMaterializedLeases(
  leases: OmkRunResourceLeases,
  runId: string,
  expectedAnalysisOnly: readonly OmkAnalysisOnlyResourceLeaseRequest[],
  hostResources: ResolvedHostResources,
): OmkRunResourceLeases {
  const bindings = record(leases?.bindingsByBindingId);
  const analysisOnly = record(leases?.analysisOnlyResourcesByResourceId);
  if (record(leases) === undefined || leases.runId !== runId
      || typeof bindings?.get !== 'function' || typeof bindings?.keys !== 'function'
      || typeof analysisOnly?.get !== 'function' || typeof analysisOnly?.keys !== 'function'
      || typeof leases.dispose !== 'function') fail({
    code: 'OMK_EVALUATION_RUNTIME_RESOURCE_LEASE_INVALID',
    runId,
    message: 'Resource lease materializer 返回了不合法或 run identity 不一致的 lease。',
  });
  let bindingEntries: Array<[string, OmkBindingResourceLease]>;
  let analysisEntries: Array<[string, OmkLeasedHostResource]>;
  try {
    bindingEntries = [...leases.bindingsByBindingId];
    analysisEntries = [...leases.analysisOnlyResourcesByResourceId];
  } catch (cause) {
    return fail({
      code: 'OMK_EVALUATION_RUNTIME_RESOURCE_LEASE_INVALID',
      runId,
      message: 'Resource lease maps 无法建立不可变快照。',
      cause,
    });
  }
  const expectedAnalysisIds = expectedAnalysisOnly
    .map((request) => request.resourceId).sort();
  const actualAnalysisIds = analysisEntries.map(([resourceId]) => resourceId).sort();
  if (actualAnalysisIds.length !== expectedAnalysisIds.length
      || actualAnalysisIds.some((resourceId, index) => (
        resourceId !== expectedAnalysisIds[index]
      ))) fail({
    code: 'OMK_EVALUATION_RUNTIME_RESOURCE_LEASE_INVALID',
    runId,
    message: 'Analysis-only resource lease 未精确覆盖 compiled orchestration。',
  });
  const snapshotResource = (resource: OmkLeasedHostResource): OmkLeasedHostResource => {
    try {
      return deepFreezeCanonicalJson(
        structuredClone(resource) as unknown as JsonValue,
      ) as unknown as OmkLeasedHostResource;
    } catch (cause) {
      return fail({
        code: 'OMK_EVALUATION_RUNTIME_RESOURCE_LEASE_INVALID',
        runId,
        message: 'Leased resource 无法建立规范化不可变快照。',
        cause,
      });
    }
  };
  const inventory = new Map(hostResources.resources.map((resource) => [
    resource.descriptor.resourceId,
    resource,
  ]));
  const assertInventoryIdentity = (resource: OmkLeasedHostResource): void => {
    try {
      const expected = inventory.get(resource.resourceId);
      const snapshotPaths = resource.leaseMode === 'immutable-snapshot'
        ? [resource.snapshotPath]
        : [resource.baseSnapshotPath, resource.overlayPath];
      if (expected !== undefined && resource.resourceKind === expected.resourceKind
          && canonicalizeJson(resource.descriptor) === canonicalizeJson(expected.descriptor)
          && !snapshotPaths.includes(expected.locator)) return;
    } catch {
      // Normalize malformed custom materializer output to the stable host boundary below.
    }
    fail({
      code: 'OMK_EVALUATION_RUNTIME_RESOURCE_LEASE_INVALID',
      runId,
      message: 'Leased resource 与 compiled HostResource identity 不一致或仍指向原 locator。',
    });
  };
  const capturedBindings = new Map<string, OmkBindingResourceLease>();
  for (const [bindingId, lease] of bindingEntries) {
    let resourceEntries: Array<[string, OmkLeasedHostResource]>;
    try {
      resourceEntries = [...lease.resourcesByResourceId];
    } catch (cause) {
      return fail({
        code: 'OMK_EVALUATION_RUNTIME_RESOURCE_LEASE_INVALID',
        runId,
        message: `Binding "${bindingId}" 的 resource map 无法建立快照。`,
        cause,
      });
    }
    const capturedResources = resourceEntries.map(([resourceId, resource]) => {
      const captured = snapshotResource(resource);
      assertInventoryIdentity(captured);
      return [resourceId, captured] as const;
    });
    capturedBindings.set(bindingId, Object.freeze({
      bindingId: lease.bindingId,
      consumerKind: lease.consumerKind,
      resourcesByResourceId: readonlyMapSnapshot(new Map(capturedResources)),
    }));
  }
  const capturedAnalysis = new Map<string, OmkLeasedHostResource>();
  for (const [resourceId, resource] of analysisEntries) {
    const captured = snapshotResource(resource);
    assertInventoryIdentity(captured);
    if (captured.resourceId !== resourceId || captured.resourceKind !== 'gold-dataset'
        || captured.descriptor.classification !== 'gold'
        || captured.leaseMode !== 'immutable-snapshot') fail({
      code: 'OMK_EVALUATION_RUNTIME_RESOURCE_LEASE_INVALID',
      runId,
      message: 'Analysis-only resource lease 的 identity、kind、classification 或 mode 不合法。',
    });
    capturedAnalysis.set(resourceId, captured);
  }
  const owner = leases as unknown as Readonly<Record<string, unknown>>;
  return Object.freeze({
    runId,
    bindingsByBindingId: readonlyMapSnapshot(capturedBindings),
    analysisOnlyResourcesByResourceId: readonlyMapSnapshot(capturedAnalysis),
    dispose: boundMethod(owner, 'dispose') as OmkRunResourceLeases['dispose'],
  });
}

function abortedBeforeStart(runId: string): never {
  fail({
    code: 'OMK_EVALUATION_RUNTIME_RUN_ABORTED_BEFORE_START',
    runId,
    message: `runId "${runId}" 在 Core start 前已取消。`,
  });
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function capturePreflightOptions(
  options: Readonly<OmkEvaluationPreflightOptions> | undefined,
): OmkEvaluationPreflightOptions {
  if (options === undefined) return Object.freeze({});
  if (record(options) === undefined || (options.signal !== undefined
      && (typeof options.signal.aborted !== 'boolean'
        || typeof options.signal.addEventListener !== 'function'
        || typeof options.signal.removeEventListener !== 'function'))) fail({
    code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
    fieldPath: 'prepare.signal',
    message: 'Evaluation preflight signal 不符合 AbortSignal contract。',
  });
  return Object.freeze(options.signal === undefined ? {} : { signal: options.signal });
}

async function eventWriterForRun(input: {
  factory: OmkEvaluationEventWriterFactory | undefined;
  writerMode: CliEvaluationCompileResult['policy']['eventDelivery']['writerMode'];
  runId: string;
  plan: SealedRunPlan;
}): Promise<EvaluationEngineEventWriter | undefined> {
  if (input.writerMode === 'disabled' || input.factory === undefined) return undefined;
  try {
    return capturePort(
      await input.factory(Object.freeze({ runId: input.runId, plan: input.plan })),
      ['write'],
      'support.createEventWriter result',
    );
  } catch (cause) {
    if (cause instanceof OmkEvaluationRuntimeError) throw cause;
    return fail({
      code: 'OMK_EVALUATION_RUNTIME_EVENT_WRITER_FAILED',
      runId: input.runId,
      message: 'Run-scoped EventWriter 创建失败。',
    });
  }
}

function staticRunMetadata(compiled: CliEvaluationCompileResult) {
  const metadata = compiled.runOptions.metadata;
  return {
    ...(metadata?.annotations === undefined ? {} : { annotations: metadata.annotations }),
    ...(metadata?.summaries === undefined ? {} : { summaries: metadata.summaries }),
  };
}

/** Assembles the immutable OMK host boundary without interpreting CLI flags. */
export async function createOmkEvaluationRuntime(
  input: Readonly<CreateOmkEvaluationRuntimeInput>,
): Promise<OmkEvaluationRuntime> {
  if (record(input) === undefined || record(input.support) === undefined) fail({
    code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
    message: 'Evaluation Runtime composition input 或 support ports 不合法。',
  });
  const compiled = snapshotCompiled(input.compiled);
  const resources = captureResourceOptions(input.resources);
  const clock = captureClock(input.support.clock);
  const schemaValidators = captureSchemaValidators(input.support.schemaValidators);
  const executionCache = captureCachePort({
    binding: input.support.executionCache,
    expectedSource: compiled.orchestration.cacheSources?.executionSourceLocator,
    enabled: compiled.policy.cache.executionMode !== 'disabled',
    fieldPath: 'support.executionCache',
  });
  const evaluationCache = captureCachePort({
    binding: input.support.evaluationCache,
    expectedSource: compiled.orchestration.cacheSources?.evaluationSourceLocator,
    enabled: compiled.policy.cache.evaluationMode !== 'disabled',
    fieldPath: 'support.evaluationCache',
  });
  const executionContentStore = requiredPort({
    candidate: input.support.executionContentStore,
    required: compiled.policy.evidence.output === 'reference'
      || compiled.policy.evidence.trace === 'reference',
    fieldPath: 'support.executionContentStore',
    methods: ['put'],
  });
  const evaluationContentStore = requiredPort({
    candidate: input.support.evaluationContentStore,
    required: compiled.policy.evidence.evidence === 'reference',
    fieldPath: 'support.evaluationContentStore',
    methods: ['put'],
  });
  const contentResolver = requiredPort({
    candidate: input.support.contentResolver,
    required: evaluatorNeedsReferenceResolver(compiled),
    fieldPath: 'support.contentResolver',
    methods: ['resolve'],
  });
  const createEventWriter = input.support.createEventWriter;
  if (compiled.policy.eventDelivery.writerMode === 'required'
      && typeof createEventWriter !== 'function') fail({
    code: 'OMK_EVALUATION_RUNTIME_SUPPORT_PORT_REQUIRED',
    fieldPath: 'support.createEventWriter',
    message: 'Required EventWriter mode 必须装配 run-scoped EventWriter factory。',
  });
  if (createEventWriter !== undefined && typeof createEventWriter !== 'function') fail({
    code: 'OMK_EVALUATION_RUNTIME_SUPPORT_PORT_INVALID',
    fieldPath: 'support.createEventWriter',
    message: 'Run-scoped EventWriter factory 不合法。',
  });
  const eventWriterFactory = createEventWriter === undefined
    ? undefined
    : createEventWriter.bind(input.support);

  const factories = withBuiltinFactories(input.factories);
  const assembly = await assembleOmkRuntimeBindings({
    definition: compiled.definition,
    runtimeBinding: compiled.runtimeBinding,
    factories,
    ...(compiled.orchestration.independentSeries === undefined ? {} : {
      seriesDefinition: compiled.orchestration.independentSeries.definition,
    }),
  });
  const engine = createEvaluationEngine({
    bindings: assembly.evaluation.bindings,
    clock,
    schemaValidators,
    ...(executionCache === undefined ? {} : { executionCache }),
    ...(evaluationCache === undefined ? {} : { evaluationCache }),
    ...(executionContentStore === undefined ? {} : { executionContentStore }),
    ...(evaluationContentStore === undefined ? {} : { evaluationContentStore }),
    ...(contentResolver === undefined ? {} : { contentResolver }),
  });
  const bindingLeaseRequests = resourceLeaseRequestsFromBindingEntries(
    assembly.evaluation.entries,
  );
  // Gold is consumed by the separate exploratory post-hoc workflow, never by a Core run.
  const analysisOnly: readonly OmkAnalysisOnlyResourceLeaseRequest[] = Object.freeze([]);
  const activeRunIds = new Set<string>();
  const preflightEntries = Object.freeze([
    ...assembly.evaluation.entries,
    ...(assembly.series?.entries ?? []),
  ]);

  return Object.freeze({
    ...(assembly.series === undefined ? {} : { series: assembly.series }),
    async prepare(
      options?: Readonly<OmkEvaluationPreflightOptions>,
    ): Promise<OmkPreparedEvaluation> {
      const preflightOptions = capturePreflightOptions(options);
      // Core qualification is always authoritative and runs before physical probes.
      const corePrepared: PreparedEvaluation = await engine.prepare(
        compiled.definition,
        compiled.policy,
      );
      if (compiled.orchestration.independentSeries !== undefined
          && assembly.series !== undefined) {
        prepareEvaluationSeriesPlan(
          compiled.orchestration.independentSeries.definition,
          assembly.series.runtimes,
        );
      }
      const preflight = await runOmkEvaluationPreflight({
        entries: preflightEntries,
        modes: compiled.orchestration.preflight,
        options: preflightOptions,
      });
      return Object.freeze({
        plan: corePrepared.plan,
        preflight,
        async start(options: Readonly<OmkEvaluationRunOptions>): Promise<EvaluationRun> {
          if (record(options) === undefined) fail({
            code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
            message: 'Evaluation run options 不合法。',
          });
          let capturedOptions: OmkEvaluationRunOptions;
          try {
            capturedOptions = Object.freeze({
              runId: options.runId,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
              ...(options.eventBufferCapacity === undefined ? {} : {
                eventBufferCapacity: options.eventBufferCapacity,
              }),
              ...(options.progressSink === undefined ? {} : {
                progressSink: options.progressSink,
              }),
              ...(options.progressBufferCapacity === undefined ? {} : {
                progressBufferCapacity: options.progressBufferCapacity,
              }),
            });
          } catch {
            return fail({
              code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
              message: 'Evaluation run options 无法安全捕获。',
            });
          }
          const {
            runId,
            signal,
            eventBufferCapacity,
            progressSink,
            progressBufferCapacity,
          } = capturedOptions;
          if (!IdentifierSchema.safeParse(runId).success) fail({
            code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
            fieldPath: 'runId',
            message: 'runId 不符合 Core identifier contract。',
          });
          if (eventBufferCapacity !== undefined
              && (!Number.isSafeInteger(eventBufferCapacity)
                || eventBufferCapacity <= 0)) fail({
            code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
            fieldPath: 'eventBufferCapacity',
            message: 'eventBufferCapacity 必须是正安全整数。',
          });
          if (signal !== undefined
              && (typeof signal.aborted !== 'boolean'
                || typeof signal.addEventListener !== 'function'
                || typeof signal.removeEventListener !== 'function')) fail({
            code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
            fieldPath: 'signal',
            message: 'signal 不符合 AbortSignal contract。',
          });
          let progressProjection: CapturedOmkEvaluationProgressProjection | undefined;
          if (progressSink !== undefined) {
            try {
              progressProjection = captureOmkEvaluationProgressProjection(
                progressSink,
                progressBufferCapacity === undefined ? {} : {
                  progressBufferCapacity,
                },
              );
            } catch {
              fail({
                code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
                fieldPath: 'progressSink',
                message: 'Evaluation progress sink 或 buffer capacity 不合法。',
              });
            }
          } else if (progressBufferCapacity !== undefined) fail({
            code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
            fieldPath: 'progressBufferCapacity',
            message: '未提供 progress sink 时不能配置 progress buffer。',
          });
          if (activeRunIds.has(runId)) fail({
            code: 'OMK_EVALUATION_RUNTIME_RUN_ACTIVE',
            runId,
            message: `runId "${runId}" 已有 active OMK evaluation run。`,
          });
          if (signalIsAborted(signal)) return abortedBeforeStart(runId);
          activeRunIds.add(runId);
          let leases: OmkRunResourceLeases | undefined;
          let registered = false;
          let cleanupPromise: Promise<void> | undefined;
          const cleanup = (): Promise<void> => {
            cleanupPromise ??= (async () => {
              let unregisterFailure: unknown;
              if (registered) {
                try {
                  assembly.evaluation.resourceLeaseRegistry.unregister(runId);
                } catch (cause) {
                  unregisterFailure = cause;
                }
                registered = false;
              }
              let disposeFailure: unknown;
              try {
                await leases?.dispose();
              } catch (cause) {
                disposeFailure = cause;
              }
              if (unregisterFailure !== undefined || disposeFailure !== undefined) fail({
                code: 'OMK_EVALUATION_RUNTIME_CLEANUP_FAILED',
                runId,
                message: 'Run resource lease 清理失败。',
                cause: unregisterFailure === undefined
                  ? disposeFailure
                  : disposeFailure === undefined
                    ? unregisterFailure
                    : new AggregateError([unregisterFailure, disposeFailure]),
              });
            })();
            return cleanupPromise;
          };
          try {
            try {
              leases = await resources.materialize({
                runId,
                hostResources: compiled.hostResources,
                bindings: bindingLeaseRequests,
                analysisOnly,
                leaseRoot: resources.leaseRoot,
                ...(resources.limits === undefined ? {} : {
                  limits: resources.limits,
                }),
                ...(resources.pinnedGitVerifier === undefined ? {} : {
                  pinnedGitVerifier: resources.pinnedGitVerifier,
                }),
              });
            } catch (cause) {
              if (cause instanceof OmkResourceLeaseError) throw cause;
              return fail({
                code: 'OMK_EVALUATION_RUNTIME_RESOURCE_LEASE_FAILED',
                runId,
                message: 'Run resource lease acquisition 失败。',
              });
            }
            leases = captureMaterializedLeases(
              leases,
              runId,
              analysisOnly,
              compiled.hostResources,
            );
            assembly.evaluation.resourceLeaseRegistry.register(leases);
            registered = true;
            if (signalIsAborted(signal)) {
              await cleanup();
              return abortedBeforeStart(runId);
            }
            const eventWriter = await eventWriterForRun({
              factory: eventWriterFactory,
              writerMode: compiled.policy.eventDelivery.writerMode,
              runId,
              plan: corePrepared.plan,
            });
            let coreRun: EvaluationRun;
            try {
              coreRun = corePrepared.start({
                runId,
                ...staticRunMetadata(compiled),
                ...(signal === undefined ? {} : { signal }),
                ...(eventBufferCapacity === undefined ? {} : {
                  eventBufferCapacity,
                }),
                ...(eventWriter === undefined ? {} : { eventWriter }),
              });
            } catch (cause) {
              return fail({
                code: 'OMK_EVALUATION_RUNTIME_START_FAILED',
                runId,
                message: 'Evaluation Core start 失败。',
                cause,
              });
            }
            const result = coreRun.result.then(
              async (value) => {
                await cleanup();
                return value;
              },
              async (cause) => {
                try {
                  await cleanup();
                } catch (cleanupCause) {
                  return fail({
                    code: 'OMK_EVALUATION_RUNTIME_CLEANUP_FAILED',
                    runId,
                    message: 'Evaluation Core failure 后的 resource lease 清理失败。',
                    cause: new AggregateError([cause, cleanupCause]),
                  });
                }
                throw cause;
              },
            ).finally(() => {
              activeRunIds.delete(runId);
            });
            const hostRun = Object.freeze({ events: coreRun.events, result });
            return progressProjection === undefined
              ? hostRun
              : attachOmkEvaluationProgressProjection(
                  hostRun,
                  progressProjection,
                  eventBufferCapacity,
                );
          } catch (cause) {
            try {
              await cleanup();
            } catch (cleanupCause) {
              activeRunIds.delete(runId);
              return fail({
                code: 'OMK_EVALUATION_RUNTIME_CLEANUP_FAILED',
                runId,
                message: 'Evaluation Core 启动失败后的 resource lease 清理失败。',
                cause: new AggregateError([cause, cleanupCause]),
              });
            }
            activeRunIds.delete(runId);
            throw cause;
          }
        },
      });
    },
  });
}
