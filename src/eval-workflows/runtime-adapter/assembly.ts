import {
  RuntimeIdentitySchema,
  SchemaIdentitySchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type EvaluationDefinition,
  type EvaluationSeriesDefinition,
  type RuntimeIdentity,
} from '../../evaluation-core/contracts/index.js';
import type {
  AnalysisRuntimeRequirement,
  EvaluatorRuntimeRequirement,
  ExecutorRuntimeRequirement,
  RuntimeResolution,
} from '../../evaluation-core/compiler/index.js';
import {
  RUNTIME_BINDING_REQUEST_SCHEMA_VERSION,
  type RuntimeBinding,
  type RuntimeResourceLeaseRequirement,
} from '../input-compilation/index.js';
import {
  OmkRuntimeAssemblyError,
  type AssembleOmkRuntimeBindingsInput,
  type OmkEvaluationRuntimeBindingEntry,
  type OmkEvaluationSeriesRuntimeBindingEntry,
  type OmkRuntimeBindingAssembly,
  type OmkRuntimeBindingFactories,
  type OmkRuntimePortBinding,
  type RuntimeBindingOf,
} from './types.js';
import {
  createOmkResourceLeaseAccessRegistry,
  type OmkResourceLeaseAccessRegistry,
} from './resource-leases/access.js';

type EvaluationBindingKind = Exclude<
  RuntimeBinding['runtimeKind'],
  'series-analysis-node' | 'series-decision-policy'
>;

interface ExpectedBinding {
  readonly runtimeKind: RuntimeBinding['runtimeKind'];
  readonly referenceId: string;
  readonly implementationId: string;
  readonly versionConstraint?: string;
  readonly analysisRequirementKind?: 'analysis-node' | 'sampling-estimator';
  readonly analysisNodeKind?: 'reducer' | 'estimator' | 'correction';
  readonly subject: unknown;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(input: ConstructorParameters<typeof OmkRuntimeAssemblyError>[0]): never {
  throw new OmkRuntimeAssemblyError(input);
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function bindingReferenceId(binding: RuntimeBinding): string {
  switch (binding.runtimeKind) {
    case 'executor': return binding.targetId;
    case 'evaluator': return binding.evaluatorId;
    case 'analysis-node': return binding.referenceId;
    case 'series-analysis-node': return binding.nodeId;
    case 'missing-policy': return binding.policyId;
    case 'decision-policy':
    case 'series-decision-policy': return binding.decisionPolicyId;
  }
}

function bindingKey(
  runtimeKind: RuntimeBinding['runtimeKind'],
  referenceId: string,
  analysisRequirementKind?: 'analysis-node' | 'sampling-estimator',
): string {
  return runtimeKind === 'analysis-node'
    ? `${runtimeKind}\u0000${analysisRequirementKind ?? ''}\u0000${referenceId}`
    : `${runtimeKind}\u0000${referenceId}`;
}

function keyForBinding(binding: RuntimeBinding): string {
  return bindingKey(
    binding.runtimeKind,
    bindingReferenceId(binding),
    binding.runtimeKind === 'analysis-node' ? binding.requirementKind : undefined,
  );
}

function keyForExpected(binding: ExpectedBinding): string {
  return bindingKey(
    binding.runtimeKind,
    binding.referenceId,
    binding.analysisRequirementKind,
  );
}

function expectedBindings(
  definition: EvaluationDefinition,
  seriesDefinition: EvaluationSeriesDefinition | undefined,
): Map<string, ExpectedBinding> {
  const expected = new Map<string, ExpectedBinding>();
  const add = (binding: ExpectedBinding): void => {
    const key = keyForExpected(binding);
    if (expected.has(key)) fail({
      code: 'OMK_RUNTIME_BINDING_DEFINITION_MISMATCH',
      referenceId: binding.referenceId,
      message: 'Definition 包含重复 Runtime reference。',
    });
    expected.set(key, binding);
  };
  for (const target of definition.targets) add({
    runtimeKind: 'executor',
    referenceId: target.targetId,
    implementationId: target.executorId,
    ...(target.versionConstraint === undefined ? {} : { versionConstraint: target.versionConstraint }),
    subject: target,
  });
  for (const evaluator of definition.evaluators) add({
    runtimeKind: 'evaluator',
    referenceId: evaluator.evaluatorId,
    implementationId: evaluator.implementationId,
    ...(evaluator.versionConstraint === undefined ? {} : {
      versionConstraint: evaluator.versionConstraint,
    }),
    subject: evaluator,
  });
  for (const node of definition.analysisGraph.nodes) add({
    runtimeKind: 'analysis-node',
    referenceId: node.nodeId,
    implementationId: node.implementationId,
    ...(node.versionConstraint === undefined ? {} : { versionConstraint: node.versionConstraint }),
    analysisRequirementKind: 'analysis-node',
    analysisNodeKind: node.analysisNodeKind,
    subject: node,
  });
  add({
    runtimeKind: 'analysis-node',
    referenceId: definition.experiment.sampling.estimatorId,
    implementationId: definition.experiment.sampling.estimatorId,
    analysisRequirementKind: 'sampling-estimator',
    analysisNodeKind: 'estimator',
    subject: definition.experiment.sampling,
  });
  const metricsByMissingPolicy = new Map<string, string[]>();
  for (const metric of definition.metrics) {
    const metricIds = metricsByMissingPolicy.get(metric.missingPolicyId) ?? [];
    metricIds.push(metric.metricId);
    metricsByMissingPolicy.set(metric.missingPolicyId, metricIds);
  }
  for (const [policyId, metricIds] of [...metricsByMissingPolicy].sort(([left], [right]) => (
    compareStrings(left, right)
  ))) add({
    runtimeKind: 'missing-policy',
    referenceId: policyId,
    implementationId: policyId,
    subject: Object.freeze(metricIds.sort(compareStrings)),
  });
  if (definition.decisionPolicy !== undefined) add({
    runtimeKind: 'decision-policy',
    referenceId: definition.decisionPolicy.decisionPolicyId,
    implementationId: definition.decisionPolicy.implementationId,
    ...(definition.decisionPolicy.versionConstraint === undefined ? {} : {
      versionConstraint: definition.decisionPolicy.versionConstraint,
    }),
    subject: definition.decisionPolicy,
  });
  for (const node of seriesDefinition?.analysisGraph.nodes ?? []) add({
    runtimeKind: 'series-analysis-node',
    referenceId: node.nodeId,
    implementationId: node.implementationId,
    subject: node,
  });
  if (seriesDefinition?.decisionPolicy !== undefined) add({
    runtimeKind: 'series-decision-policy',
    referenceId: seriesDefinition.decisionPolicy.decisionPolicyId,
    implementationId: seriesDefinition.decisionPolicy.implementationId,
    subject: seriesDefinition.decisionPolicy,
  });
  return expected;
}

function sameOptionalString(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function descriptorResourceId(value: unknown): string | undefined {
  const descriptor = record(value);
  return typeof descriptor?.resourceId === 'string' && descriptor.resourceId !== ''
    ? descriptor.resourceId
    : undefined;
}

function expectedExecutorResourceRequirements(
  target: EvaluationDefinition['targets'][number],
): RuntimeResourceLeaseRequirement[] {
  const config = record(target.config);
  const behavior = record(config?.behavior);
  const artifactId = descriptorResourceId(behavior?.artifact);
  if (artifactId === undefined) fail({
    code: 'OMK_RUNTIME_BINDING_DEFINITION_MISMATCH',
    referenceId: target.targetId,
    message: 'Target behavior 缺少 artifact resource descriptor。',
  });
  const requirements: RuntimeResourceLeaseRequirement[] = [{
    resourceId: artifactId,
    resourceRole: 'artifact',
    leaseMode: 'immutable-snapshot',
  }];
  const workspaceId = descriptorResourceId(behavior?.workspace);
  if (workspaceId !== undefined) requirements.push({
    resourceId: workspaceId,
    resourceRole: 'workspace',
    leaseMode: 'copy-on-write-overlay',
  });
  const mcpConfigId = descriptorResourceId(behavior?.mcpConfig);
  if (mcpConfigId !== undefined) requirements.push({
    resourceId: mcpConfigId,
    resourceRole: 'mcp-config',
    leaseMode: 'immutable-snapshot',
  });
  if (Array.isArray(behavior?.mocks)) {
    for (const mockValue of behavior.mocks) {
      const mock = record(mockValue);
      if (!Array.isArray(mock?.payloads)) continue;
      for (const payload of mock.payloads) {
        const resourceId = descriptorResourceId(payload);
        if (resourceId !== undefined) requirements.push({
          resourceId,
          resourceRole: 'mock-payload',
          leaseMode: 'immutable-snapshot',
        });
      }
    }
  }
  return [...new Map(requirements.map((requirement) => [
    `${requirement.resourceRole}\u0000${requirement.resourceId}`,
    requirement,
  ])).values()].sort((left, right) => (
    compareStrings(left.resourceRole, right.resourceRole)
    || compareStrings(left.resourceId, right.resourceId)
  ));
}

function assertResourceRequirements(
  binding: RuntimeBindingOf<'executor'> | RuntimeBindingOf<'evaluator'>,
): void {
  const keys = new Set<string>();
  for (const requirement of binding.resourceLeaseRequirements) {
    const expectedMode = requirement.resourceRole === 'workspace'
      ? 'copy-on-write-overlay'
      : 'immutable-snapshot';
    const allowedRole = binding.runtimeKind === 'executor'
      ? ['artifact', 'workspace', 'mcp-config', 'mock-payload'].includes(requirement.resourceRole)
      : requirement.resourceRole === 'content';
    const key = `${requirement.resourceRole}\u0000${requirement.resourceId}`;
    if (requirement.resourceId === '' || !allowedRole
        || requirement.leaseMode !== expectedMode || keys.has(key)) fail({
      code: 'OMK_RUNTIME_BINDING_DEFINITION_MISMATCH',
      bindingId: binding.bindingId,
      referenceId: binding.runtimeKind === 'executor' ? binding.targetId : binding.evaluatorId,
      message: 'Runtime binding 的 resource lease requirement 非法或重复。',
    });
    keys.add(key);
  }
}

function assertExecutorBinding(
  binding: RuntimeBindingOf<'executor'>,
  target: EvaluationDefinition['targets'][number],
): void {
  assertResourceRequirements(binding);
  const config = record(target.config);
  const runtime = record(config?.runtime);
  const expectedEffort = typeof runtime?.effort === 'string' ? runtime.effort : undefined;
  if (binding.targetId !== target.targetId
      || binding.implementationId !== target.executorId
      || !sameOptionalString(binding.versionConstraint, target.versionConstraint)
      || binding.protocolId !== target.protocolId
      || binding.behaviorConfigDigest !== digestCanonicalJson(target.config ?? null)
      || canonicalizeJson(binding.resourceLeaseRequirements)
        !== canonicalizeJson(expectedExecutorResourceRequirements(target))
      || canonicalizeJson(binding.qualification.executionRequirements)
        !== canonicalizeJson(target.executionRequirements)
      || binding.qualification.model !== runtime?.model
      || binding.qualification.effort !== expectedEffort) fail({
    code: 'OMK_RUNTIME_BINDING_DEFINITION_MISMATCH',
    bindingId: binding.bindingId,
    referenceId: binding.targetId,
    message: 'Executor binding 与 Target Definition 不一致。',
  });
}

function assertEvaluatorBinding(
  binding: RuntimeBindingOf<'evaluator'>,
  evaluator: EvaluationDefinition['evaluators'][number],
): void {
  assertResourceRequirements(binding);
  const expectedConfigDigest = evaluator.config === undefined
    ? undefined
    : digestCanonicalJson(evaluator.config);
  if (binding.evaluatorId !== evaluator.evaluatorId
      || binding.implementationId !== evaluator.implementationId
      || !sameOptionalString(binding.versionConstraint, evaluator.versionConstraint)
      || canonicalizeJson(binding.measurement) !== canonicalizeJson(evaluator.measurement)
      || binding.configDigest !== expectedConfigDigest) fail({
    code: 'OMK_RUNTIME_BINDING_DEFINITION_MISMATCH',
    bindingId: binding.bindingId,
    referenceId: binding.evaluatorId,
    message: 'Evaluator binding 与 Evaluator Definition 不一致。',
  });
}

function validateBindingAgainstDefinition(binding: RuntimeBinding, expected: ExpectedBinding): void {
  if (binding.runtimeKind !== expected.runtimeKind
      || binding.implementationId !== expected.implementationId
      || !sameOptionalString(
        'versionConstraint' in binding ? binding.versionConstraint : undefined,
        expected.versionConstraint,
      )) fail({
    code: 'OMK_RUNTIME_BINDING_DEFINITION_MISMATCH',
    bindingId: binding.bindingId,
    referenceId: expected.referenceId,
    message: 'Runtime binding implementation 与 Definition 不一致。',
  });
  if (binding.runtimeKind === 'executor') {
    assertExecutorBinding(
      binding,
      expected.subject as EvaluationDefinition['targets'][number],
    );
  } else if (binding.runtimeKind === 'evaluator') {
    assertEvaluatorBinding(
      binding,
      expected.subject as EvaluationDefinition['evaluators'][number],
    );
  } else if (binding.runtimeKind === 'analysis-node'
      && (binding.requirementKind !== expected.analysisRequirementKind
        || binding.analysisNodeKind !== expected.analysisNodeKind
        || binding.referenceId !== expected.referenceId)) fail({
    code: 'OMK_RUNTIME_BINDING_DEFINITION_MISMATCH',
    bindingId: binding.bindingId,
    referenceId: binding.referenceId,
    message: 'Analysis binding 与 Core Runtime requirement 不一致。',
  });
}

const RUNTIME_KINDS = new Set<RuntimeBinding['runtimeKind']>([
  'executor',
  'evaluator',
  'analysis-node',
  'missing-policy',
  'decision-policy',
  'series-analysis-node',
  'series-decision-policy',
]);

function isRuntimeKind(value: unknown): value is RuntimeBinding['runtimeKind'] {
  return typeof value === 'string' && RUNTIME_KINDS.has(value as RuntimeBinding['runtimeKind']);
}

function missingReferenceFromKey(key: string): string | undefined {
  const parts = key.split('\u0000');
  return parts.at(-1);
}

function assertRuntimeBindingShape(binding: unknown): asserts binding is RuntimeBinding {
  const candidate = record(binding);
  if (candidate === undefined
      || typeof candidate.bindingId !== 'string' || candidate.bindingId === ''
      || typeof candidate.implementationId !== 'string' || candidate.implementationId === ''
      || !isRuntimeKind(candidate.runtimeKind)) fail({
    code: 'OMK_RUNTIME_BINDING_REQUEST_INVALID',
    message: 'Runtime binding 缺少合法 kind、bindingId 或 implementationId。',
  });
  const referenceId = candidate.runtimeKind === 'executor'
    ? candidate.targetId
    : candidate.runtimeKind === 'evaluator'
      ? candidate.evaluatorId
      : candidate.runtimeKind === 'analysis-node'
        ? candidate.referenceId
        : candidate.runtimeKind === 'missing-policy'
          ? candidate.policyId
          : candidate.runtimeKind === 'decision-policy'
            || candidate.runtimeKind === 'series-decision-policy'
            ? candidate.decisionPolicyId
            : candidate.nodeId;
  if (typeof referenceId !== 'string' || referenceId === ''
      || ('versionConstraint' in candidate
        && candidate.versionConstraint !== undefined
        && typeof candidate.versionConstraint !== 'string')
      || ((candidate.runtimeKind === 'executor' || candidate.runtimeKind === 'evaluator')
        && !Array.isArray(candidate.resourceLeaseRequirements))) fail({
    code: 'OMK_RUNTIME_BINDING_REQUEST_INVALID',
    bindingId: candidate.bindingId,
    message: 'Runtime binding 缺少合法 reference、version 或 resource requirement。',
  });
  if (candidate.runtimeKind === 'analysis-node'
      && (typeof candidate.referenceId !== 'string' || candidate.referenceId === ''
        || !['analysis-node', 'sampling-estimator'].includes(String(candidate.requirementKind))
        || !['reducer', 'estimator', 'correction'].includes(String(candidate.analysisNodeKind)))) fail({
    code: 'OMK_RUNTIME_BINDING_REQUEST_INVALID',
    bindingId: candidate.bindingId,
    message: 'Analysis binding 缺少合法 reference 或 requirement discriminator。',
  });
}

function validateRequest(input: AssembleOmkRuntimeBindingsInput): Map<string, ExpectedBinding> {
  const request = input.runtimeBinding;
  if (request === null || typeof request !== 'object'
      || request.schemaVersion !== RUNTIME_BINDING_REQUEST_SCHEMA_VERSION
      || !Array.isArray(request.bindings)) fail({
    code: 'OMK_RUNTIME_BINDING_REQUEST_INVALID',
    message: 'RuntimeBindingRequest 版本或结构不受支持。',
  });
  const expected = expectedBindings(input.definition, input.seriesDefinition);
  const bindingIds = new Set<string>();
  const keys = new Set<string>();
  for (const candidate of request.bindings) {
    assertRuntimeBindingShape(candidate);
    const binding = candidate;
    const referenceId = bindingReferenceId(binding);
    const key = keyForBinding(binding);
    if (bindingIds.has(binding.bindingId) || keys.has(key)) fail({
      code: 'OMK_RUNTIME_BINDING_DUPLICATE',
      bindingId: binding.bindingId,
      referenceId,
      message: 'RuntimeBindingRequest 包含重复 bindingId 或 reference。',
    });
    bindingIds.add(binding.bindingId);
    keys.add(key);
    const expectedBinding = expected.get(key);
    if (expectedBinding === undefined) fail({
      code: 'OMK_RUNTIME_BINDING_COVERAGE_MISMATCH',
      bindingId: binding.bindingId,
      referenceId,
      message: 'RuntimeBindingRequest 包含 Definition 未声明的 binding。',
    });
    try {
      validateBindingAgainstDefinition(binding, expectedBinding);
    } catch (cause) {
      if (cause instanceof OmkRuntimeAssemblyError) throw cause;
      fail({
        code: 'OMK_RUNTIME_BINDING_REQUEST_INVALID',
        bindingId: binding.bindingId,
        referenceId,
        message: 'Runtime binding 结构不合法。',
        cause,
      });
    }
  }
  const missing = [...expected.keys()].filter((key) => !keys.has(key));
  if (missing.length > 0 || keys.size !== expected.size) fail({
    code: 'OMK_RUNTIME_BINDING_COVERAGE_MISMATCH',
    referenceId: missing[0] === undefined ? undefined : missingReferenceFromKey(missing[0]),
    message: 'RuntimeBindingRequest 未精确覆盖 Definition／Series 所需 Runtime。',
  });
  return expected;
}

function factoryFor(
  factories: OmkRuntimeBindingFactories,
  binding: RuntimeBinding,
): ((context: never) => unknown) | undefined {
  switch (binding.runtimeKind) {
    case 'executor': return factories.executorsByImplementationId.get(binding.implementationId);
    case 'evaluator': return factories.evaluatorsByImplementationId.get(binding.implementationId);
    case 'analysis-node': return factories.analysisNodesByImplementationId.get(binding.implementationId);
    case 'missing-policy': return factories.missingPoliciesByImplementationId.get(binding.implementationId);
    case 'decision-policy': return factories.decisionPoliciesByImplementationId.get(binding.implementationId);
    case 'series-analysis-node': return factories.seriesAnalysisNodesByImplementationId
      .get(binding.implementationId);
    case 'series-decision-policy': return factories.seriesDecisionPoliciesByImplementationId
      .get(binding.implementationId);
  }
}

function assertFactoriesAvailable(
  bindings: readonly RuntimeBinding[],
  factories: OmkRuntimeBindingFactories,
): void {
  for (const binding of bindings) {
    if (factoryFor(factories, binding) !== undefined) continue;
    fail({
      code: 'OMK_RUNTIME_BINDING_FACTORY_MISSING',
      bindingId: binding.bindingId,
      referenceId: bindingReferenceId(binding),
      message: '没有 Runtime factory 能解析声明的 implementationId。',
    });
  }
}

function sessionIsolationKey(binding: RuntimeBinding): string {
  return digestCanonicalJson({
    derivation: 'omk.runtime-binding-session-isolation/v1',
    binding,
  });
}

function contextFor(
  binding: RuntimeBinding,
  expected: ExpectedBinding,
  isolationKey: string,
  resourceLeaseAccess: OmkResourceLeaseAccessRegistry,
): unknown {
  switch (binding.runtimeKind) {
    case 'executor': return Object.freeze({
      binding,
      target: expected.subject,
      sessionIsolationKey: isolationKey,
      resourceLeases: resourceLeaseAccess.accessFor(binding),
    });
    case 'evaluator': return Object.freeze({
      binding,
      evaluator: expected.subject,
      sessionIsolationKey: isolationKey,
      resourceLeases: resourceLeaseAccess.accessFor(binding),
    });
    case 'analysis-node': return Object.freeze({
      binding,
      sessionIsolationKey: isolationKey,
      requirement: Object.freeze({
        referenceId: binding.referenceId,
        implementationId: binding.implementationId,
        ...(binding.versionConstraint === undefined ? {} : {
          versionConstraint: binding.versionConstraint,
        }),
        analysisNodeKind: binding.analysisNodeKind,
        requirementKind: binding.requirementKind,
      }),
      subject: expected.subject,
    });
    case 'missing-policy': return Object.freeze({
      binding, metricIds: expected.subject, sessionIsolationKey: isolationKey,
    });
    case 'decision-policy': return Object.freeze({
      binding, policy: expected.subject, sessionIsolationKey: isolationKey,
    });
    case 'series-analysis-node': return Object.freeze({
      binding, node: expected.subject, sessionIsolationKey: isolationKey,
    });
    case 'series-decision-policy': return Object.freeze({
      binding, policy: expected.subject, sessionIsolationKey: isolationKey,
    });
  }
}

function assertPortShape(
  binding: RuntimeBinding,
  port: Readonly<Record<string, unknown>>,
  identity: RuntimeIdentity,
): void {
  const callable = (name: string): boolean => typeof port[name] === 'function';
  const portOutputSchema = SchemaIdentitySchema.safeParse(port.outputSchema);
  const identityOutputSchema = SchemaIdentitySchema.safeParse(
    record(identity.capabilities)?.outputSchema,
  );
  const valid = binding.runtimeKind === 'executor' || binding.runtimeKind === 'evaluator'
    ? callable('openRun')
    : binding.runtimeKind === 'analysis-node'
      ? callable('openRun')
        && portOutputSchema.success
        && identityOutputSchema.success
        && canonicalizeJson(portOutputSchema.data) === canonicalizeJson(identityOutputSchema.data)
      : binding.runtimeKind === 'missing-policy'
        ? callable('decide')
        : binding.runtimeKind === 'decision-policy'
          ? callable('decide')
          : binding.runtimeKind === 'series-analysis-node'
            ? callable('analyze') && SchemaIdentitySchema.safeParse(port.outputSchema).success
            : callable('decide');
  if (!valid) fail({
    code: 'OMK_RUNTIME_BINDING_PORT_INVALID',
    bindingId: binding.bindingId,
    referenceId: bindingReferenceId(binding),
    message: 'Runtime binding factory 返回了不符合 kind contract 的 port。',
  });
}

function boundMethod(
  port: Readonly<Record<string, unknown>>,
  methodName: string,
): (...args: never[]) => unknown {
  const method = port[methodName] as (...args: never[]) => unknown;
  return (...args: never[]) => Reflect.apply(method, port, args);
}

function capturePort(
  binding: RuntimeBinding,
  port: Readonly<Record<string, unknown>>,
  identity: RuntimeIdentity,
): unknown {
  switch (binding.runtimeKind) {
    case 'executor':
    case 'evaluator': return Object.freeze({ identity, openRun: boundMethod(port, 'openRun') });
    case 'analysis-node': return Object.freeze({
      identity,
      outputSchema: deepFreezeCanonicalJson(SchemaIdentitySchema.parse(port.outputSchema)),
      openRun: boundMethod(port, 'openRun'),
    });
    case 'missing-policy':
    case 'decision-policy':
    case 'series-decision-policy': return Object.freeze({
      identity,
      decide: boundMethod(port, 'decide'),
    });
    case 'series-analysis-node': return Object.freeze({
      identity,
      outputSchema: deepFreezeCanonicalJson(SchemaIdentitySchema.parse(port.outputSchema)),
      analyze: boundMethod(port, 'analyze'),
    });
  }
}

async function materializeEntry(
  binding: RuntimeBinding,
  expected: ExpectedBinding,
  factories: OmkRuntimeBindingFactories,
  resourceLeaseAccess: OmkResourceLeaseAccessRegistry,
): Promise<OmkEvaluationRuntimeBindingEntry | OmkEvaluationSeriesRuntimeBindingEntry> {
  const factory = factoryFor(factories, binding);
  if (factory === undefined) fail({
    code: 'OMK_RUNTIME_BINDING_FACTORY_MISSING',
    bindingId: binding.bindingId,
    referenceId: bindingReferenceId(binding),
    message: '没有 Runtime factory 能解析声明的 implementationId。',
  });
  let result: OmkRuntimePortBinding<unknown>;
  const isolationKey = sessionIsolationKey(binding);
  try {
    result = await factory(
      contextFor(binding, expected, isolationKey, resourceLeaseAccess) as never,
    ) as OmkRuntimePortBinding<unknown>;
  } catch (cause) {
    fail({
      code: 'OMK_RUNTIME_BINDING_FACTORY_FAILED',
      bindingId: binding.bindingId,
      referenceId: bindingReferenceId(binding),
      message: 'Runtime binding factory 装配失败。',
      cause,
    });
  }
  const port = record(result?.port);
  const identity = RuntimeIdentitySchema.safeParse(port?.identity);
  if (port === undefined || !identity.success
      || typeof result.satisfiesVersionConstraint !== 'boolean'
      || identity.data.implementationId !== binding.implementationId) fail({
    code: 'OMK_RUNTIME_BINDING_PORT_INVALID',
    bindingId: binding.bindingId,
    referenceId: bindingReferenceId(binding),
    message: 'Runtime port identity 或 version resolution 与 binding 不一致。',
  });
  assertPortShape(binding, port, identity.data);
  const capturedIdentity = deepFreezeCanonicalJson(identity.data);
  const capturedPort = capturePort(binding, port, capturedIdentity);
  const resolution: RuntimeResolution = Object.freeze({
    identity: capturedIdentity,
    satisfiesVersionConstraint: result.satisfiesVersionConstraint,
  });
  const resourceLeaseRequirements = 'resourceLeaseRequirements' in binding
    ? binding.resourceLeaseRequirements
    : Object.freeze([]);
  return Object.freeze({
    runtimeKind: binding.runtimeKind,
    binding,
    resolution,
    port: capturedPort,
    resourceLeaseRequirements,
    sessionIsolationKey: isolationKey,
  }) as OmkEvaluationRuntimeBindingEntry | OmkEvaluationSeriesRuntimeBindingEntry;
}

function sameRequirement(
  binding: RuntimeBinding,
  requirement: ExecutorRuntimeRequirement | EvaluatorRuntimeRequirement | AnalysisRuntimeRequirement,
): boolean {
  if (bindingReferenceId(binding) !== requirement.referenceId
      || binding.implementationId !== ('executorId' in requirement
        ? requirement.executorId
        : requirement.implementationId)) return false;
  if ('versionConstraint' in binding
      && binding.versionConstraint !== ('versionConstraint' in requirement
        ? requirement.versionConstraint
        : undefined)) return false;
  if (binding.runtimeKind === 'executor') {
    return 'protocolId' in requirement
      && binding.protocolId === requirement.protocolId
      && canonicalizeJson(binding.qualification.executionRequirements)
        === canonicalizeJson(requirement.executionRequirements);
  }
  if (binding.runtimeKind === 'analysis-node') {
    return 'requirementKind' in requirement
      && (requirement.requirementKind === 'analysis-node'
      || requirement.requirementKind === 'sampling-estimator')
      && binding.requirementKind === requirement.requirementKind
      && binding.analysisNodeKind === requirement.analysisNodeKind;
  }
  return true;
}

function missingResolvedBinding(referenceId: string): never {
  fail({
    code: 'OMK_RUNTIME_BINDING_COVERAGE_MISMATCH',
    referenceId,
    message: 'Core 请求了装配快照中不存在或不一致的 Runtime binding。',
  });
}

function evaluationResolvers(entries: readonly OmkEvaluationRuntimeBindingEntry[]) {
  const executors = new Map(entries.filter((entry) => entry.runtimeKind === 'executor')
    .map((entry) => [entry.binding.targetId, entry]));
  const evaluators = new Map(entries.filter((entry) => entry.runtimeKind === 'evaluator')
    .map((entry) => [entry.binding.evaluatorId, entry]));
  const analysis = new Map(entries.filter((entry) => (
    entry.runtimeKind === 'analysis-node'
    || entry.runtimeKind === 'missing-policy'
    || entry.runtimeKind === 'decision-policy'
  )).map((entry) => [keyForBinding(entry.binding), entry]));
  return Object.freeze({
    resolveExecutor(requirement: Readonly<ExecutorRuntimeRequirement>) {
      const entry = executors.get(requirement.referenceId);
      if (entry === undefined || !sameRequirement(entry.binding, requirement)) {
        return missingResolvedBinding(requirement.referenceId);
      }
      return { runtimeKind: 'executor' as const, resolution: entry.resolution, port: entry.port };
    },
    resolveEvaluator(requirement: Readonly<EvaluatorRuntimeRequirement>) {
      const entry = evaluators.get(requirement.referenceId);
      if (entry === undefined || !sameRequirement(entry.binding, requirement)) {
        return missingResolvedBinding(requirement.referenceId);
      }
      return { runtimeKind: 'evaluator' as const, resolution: entry.resolution, port: entry.port };
    },
    resolveAnalysis(requirement: Readonly<AnalysisRuntimeRequirement>) {
      const runtimeKind: EvaluationBindingKind = requirement.requirementKind === 'missing-policy'
        ? 'missing-policy'
        : requirement.requirementKind === 'decision-policy'
          ? 'decision-policy'
          : 'analysis-node';
      const entry = analysis.get(bindingKey(
        runtimeKind,
        requirement.referenceId,
        requirement.requirementKind === 'analysis-node'
          || requirement.requirementKind === 'sampling-estimator'
          ? requirement.requirementKind
          : undefined,
      ));
      if (entry === undefined || !sameRequirement(entry.binding, requirement)) {
        return missingResolvedBinding(requirement.referenceId);
      }
      if (entry.runtimeKind === 'analysis-node') return {
        runtimeKind: 'analysis-node' as const,
        resolution: entry.resolution,
        port: entry.port,
      };
      if (entry.runtimeKind === 'missing-policy') return {
        runtimeKind: 'missing-policy' as const,
        resolution: entry.resolution,
        port: entry.port,
      };
      if (entry.runtimeKind === 'decision-policy') return {
        runtimeKind: 'decision-policy' as const,
        resolution: entry.resolution,
        port: entry.port,
      };
      return missingResolvedBinding(requirement.referenceId);
    },
  });
}

function seriesAssembly(entries: readonly OmkEvaluationSeriesRuntimeBindingEntry[]) {
  const analysisNodesByNodeId = new Map<string, Extract<
    OmkEvaluationSeriesRuntimeBindingEntry,
    { runtimeKind: 'series-analysis-node' }
  >['port']>();
  const decisionPoliciesByDecisionPolicyId = new Map<string, Extract<
    OmkEvaluationSeriesRuntimeBindingEntry,
    { runtimeKind: 'series-decision-policy' }
  >['port']>();
  const runtimes = entries.map((entry) => {
    if (entry.runtimeKind === 'series-analysis-node') {
      analysisNodesByNodeId.set(entry.binding.nodeId, entry.port);
      return Object.freeze({
        runtimeKind: entry.runtimeKind,
        referenceId: entry.binding.nodeId,
        identity: entry.resolution.identity as RuntimeIdentity,
        outputSchema: entry.port.outputSchema,
      });
    }
    decisionPoliciesByDecisionPolicyId.set(entry.binding.decisionPolicyId, entry.port);
    return Object.freeze({
      runtimeKind: entry.runtimeKind,
      referenceId: entry.binding.decisionPolicyId,
      identity: entry.resolution.identity as RuntimeIdentity,
    });
  });
  return Object.freeze({
    entries: Object.freeze([...entries]),
    runtimes: Object.freeze(runtimes),
    ports: Object.freeze({
      analysisNodesByNodeId: readonlyMapSnapshot(analysisNodesByNodeId),
      decisionPoliciesByDecisionPolicyId: readonlyMapSnapshot(
        decisionPoliciesByDecisionPolicyId,
      ),
    }),
  });
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

/**
 * Validates the complete Definition／binding request before invoking any factory,
 * then captures one immutable binding snapshot for Core prepare and execution.
 */
export async function assembleOmkRuntimeBindings(
  input: Readonly<AssembleOmkRuntimeBindingsInput>,
): Promise<OmkRuntimeBindingAssembly> {
  let snapshotInput: AssembleOmkRuntimeBindingsInput;
  try {
    snapshotInput = {
      definition: deepFreezeCanonicalJson(structuredClone(input.definition)),
      runtimeBinding: deepFreezeCanonicalJson(structuredClone(input.runtimeBinding)),
      factories: input.factories,
      ...(input.seriesDefinition === undefined ? {} : {
        seriesDefinition: deepFreezeCanonicalJson(structuredClone(input.seriesDefinition)),
      }),
    };
  } catch (cause) {
    fail({
      code: 'OMK_RUNTIME_ASSEMBLY_INPUT_INVALID',
      message: 'Runtime assembly 输入无法建立规范化不可变快照。',
      cause,
    });
  }
  const expected = validateRequest(snapshotInput);
  const ordered = [...snapshotInput.runtimeBinding.bindings].sort((left, right) => (
    compareStrings(left.bindingId, right.bindingId)
  ));
  assertFactoriesAvailable(ordered, snapshotInput.factories);
  const resourceLeaseAccess = createOmkResourceLeaseAccessRegistry(
    ordered.filter((binding): binding is Extract<RuntimeBinding, {
      runtimeKind: 'executor' | 'evaluator';
    }> => binding.runtimeKind === 'executor' || binding.runtimeKind === 'evaluator'),
  );
  const entries: Array<
    OmkEvaluationRuntimeBindingEntry | OmkEvaluationSeriesRuntimeBindingEntry
  > = [];
  for (const binding of ordered) {
    entries.push(await materializeEntry(
      binding,
      expected.get(keyForBinding(binding)) as ExpectedBinding,
      snapshotInput.factories,
      resourceLeaseAccess,
    ));
  }
  const evaluationEntries = entries.filter((entry): entry is OmkEvaluationRuntimeBindingEntry => (
    entry.runtimeKind !== 'series-analysis-node'
    && entry.runtimeKind !== 'series-decision-policy'
  ));
  const seriesEntries = entries.filter((entry): entry is OmkEvaluationSeriesRuntimeBindingEntry => (
    entry.runtimeKind === 'series-analysis-node'
    || entry.runtimeKind === 'series-decision-policy'
  ));
  return Object.freeze({
    evaluation: Object.freeze({
      entries: Object.freeze(evaluationEntries),
      bindings: evaluationResolvers(evaluationEntries),
      resourceLeaseRegistry: resourceLeaseAccess.lifecycle,
    }),
    ...(snapshotInput.seriesDefinition === undefined ? {} : { series: seriesAssembly(seriesEntries) }),
  });
}
