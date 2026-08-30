import {
  EVALUATION_DEFINITION_SCHEMA_VERSION,
  EVALUATION_SERIES_DEFINITION_SCHEMA_VERSION,
  MEASUREMENT_POLICY_SCHEMA_VERSION,
  MeasurementPolicySchema,
  createEvaluationSeriesDefinition,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  parseWireDocument,
  type EvaluationDefinition,
  type EvaluatorDefinition,
  type JsonValue,
  type MeasurementPolicy,
  type Sha256Digest,
} from '../../evaluation-core/contracts/index.js';
import {
  EvaluationDefinitionError,
  normalizeEvaluationDefinition,
  validateDefinitionSemantics,
} from '../../evaluation-core/compiler/index.js';
import { CliEvaluationInputError } from './error.js';
import {
  RESOLVED_CLI_EVALUATION_INPUT_SCHEMA_VERSION,
  RESOLVED_HOST_RESOURCES_SCHEMA_VERSION,
  RUNTIME_BINDING_REQUEST_SCHEMA_VERSION,
  type CliEvaluationCompileResult,
  type CompiledIndependentSeries,
  type EvaluationOrchestrationOptions,
  type ResolvedCliEvaluationInput,
  type ResolvedEvaluatorTemplate,
  type ResolvedHostResource,
  type ResolvedHostResources,
  type ResolvedJudgeMember,
  type ResolvedResourceDescriptor,
  type ResolvedTargetBehavior,
  type RuntimeBinding,
  type RuntimeBindingRequest,
} from './types.js';

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(input: ConstructorParameters<typeof CliEvaluationInputError>[0]): never {
  throw new CliEvaluationInputError(input);
}

function canonicalSnapshot(
  value: unknown,
  path = '$',
  ancestors: Set<object> = new Set(),
): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail({
      code: 'CLI_INPUT_INVALID',
      fieldPath: path,
      message: `输入字段「${path}」必须是有限数值。`,
    });
    return value;
  }
  if (typeof value !== 'object' || value === null) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: path,
    message: `输入字段「${path}」必须可序列化为 JSON。`,
  });
  if (ancestors.has(value)) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: path,
    message: `输入字段「${path}」不得包含循环引用。`,
  });
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      const expected = Array.from({ length: value.length }, (_, index) => String(index));
      const dataKeys = keys.filter((key): key is string => typeof key === 'string' && key !== 'length');
      if (keys.some((key) => typeof key === 'symbol')
          || dataKeys.length !== expected.length
          || dataKeys.some((key, index) => key !== expected[index])) fail({
        code: 'CLI_INPUT_INVALID',
        fieldPath: path,
        message: `输入字段「${path}」必须是无额外属性的稠密数组。`,
      });
      return expected.map((key, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) fail({
          code: 'CLI_INPUT_INVALID',
          fieldPath: `${path}/${index}`,
          message: `输入字段「${path}/${index}」必须是普通数据属性。`,
        });
        return canonicalSnapshot(descriptor.value, `${path}/${index}`, ancestors);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail({
      code: 'CLI_INPUT_INVALID',
      fieldPath: path,
      message: `输入字段「${path}」只能使用普通 JSON object。`,
    });
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail({
        code: 'CLI_INPUT_INVALID',
        fieldPath: path,
        message: `输入字段「${path}」不得包含 symbol 属性。`,
      });
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) fail({
        code: 'CLI_INPUT_INVALID',
        fieldPath: `${path}/${key}`,
        message: `输入字段「${path}/${key}」必须是普通数据属性。`,
      });
      const child = descriptor.value;
      if (child === undefined) continue;
      result[key] = canonicalSnapshot(child, `${path}/${key}`, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function descriptorSnapshot(descriptor: ResolvedResourceDescriptor): JsonValue {
  return canonicalSnapshot({
    resourceId: descriptor.resourceId,
    digest: descriptor.digest,
    mediaType: descriptor.mediaType,
    classification: descriptor.classification,
    ...(descriptor.size === undefined ? {} : { size: descriptor.size }),
  });
}

function descriptorMatches(
  left: ResolvedResourceDescriptor,
  right: ResolvedResourceDescriptor,
): boolean {
  return digestCanonicalJson(descriptorSnapshot(left))
    === digestCanonicalJson(descriptorSnapshot(right));
}

function assertUnique(values: readonly string[], fieldPath: string): void {
  if (new Set(values).size === values.length) return;
  fail({
    code: 'CLI_INPUT_DUPLICATE_ID',
    fieldPath,
    message: `输入字段「${fieldPath}」包含重复标识。`,
  });
}

function normalizeHostResources(
  input: ResolvedHostResources,
): ResolvedHostResources {
  if (input.schemaVersion !== RESOLVED_HOST_RESOURCES_SCHEMA_VERSION) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: 'hostResources.schemaVersion',
    message: '宿主资源清单版本不受支持。',
  });
  assertUnique(input.resources.map((resource) => resource.descriptor.resourceId), 'hostResources.resources[].resourceId');
  const resources = [...input.resources]
    .sort((left, right) => compareStrings(left.descriptor.resourceId, right.descriptor.resourceId))
    .map((resource) => {
      if (!['artifact', 'workspace', 'mcp-config', 'mock-payload', 'gold-dataset', 'content']
        .includes(resource.resourceKind)
          || !['public', 'sensitive', 'secret', 'gold']
            .includes(resource.descriptor.classification)
          || !['content-digest', 'tree-digest', 'pinned-git']
            .includes(resource.verification.verificationKind)) {
        fail({
          code: 'CLI_INPUT_INVALID',
          sourcePath: resource.locator,
          fieldPath: `hostResources.${resource.descriptor.resourceId || '<missing>'}`,
          message: '宿主资源的 resourceKind、classification 或 verificationKind 不合法。',
        });
      }
      if (!resource.descriptor.resourceId
          || resource.descriptor.resourceId.length > 256
          || !/^sha256:[0-9a-f]{64}$/.test(resource.descriptor.digest)
          || !resource.descriptor.mediaType
          || !resource.locator
          || (resource.descriptor.size !== undefined
            && (!Number.isInteger(resource.descriptor.size) || resource.descriptor.size < 0))) {
        fail({
          code: 'CLI_INPUT_INVALID',
          sourcePath: resource.locator,
          fieldPath: `hostResources.${resource.descriptor.resourceId || '<missing>'}`,
          message: '宿主资源 descriptor 或 locator 不合法。',
        });
      }
      if (resource.verification.verifiedDigest !== resource.descriptor.digest) fail({
        code: 'CLI_INPUT_RESOURCE_DIGEST_MISMATCH',
        sourcePath: resource.locator,
        fieldPath: `hostResources.${resource.descriptor.resourceId}.verification`,
        message: `资源「${resource.descriptor.resourceId}」的验证摘要与描述摘要不一致。`,
      });
      return {
        resourceKind: resource.resourceKind,
        descriptor: descriptorSnapshot(resource.descriptor),
        locator: resource.locator,
        ...(resource.lineage === undefined ? {} : { lineage: canonicalSnapshot(resource.lineage) }),
        verification: {
          verificationKind: resource.verification.verificationKind,
          verifiedDigest: resource.verification.verifiedDigest,
        },
      };
    });
  return deepFreezeCanonicalJson(canonicalSnapshot({
    schemaVersion: RESOLVED_HOST_RESOURCES_SCHEMA_VERSION,
    resources,
  })) as unknown as ResolvedHostResources;
}

function validateHostOptions(input: ResolvedCliEvaluationInput): void {
  const orchestration = input.orchestration;
  const presentation = input.presentation;
  if (typeof orchestration.dryRun !== 'boolean'
      || typeof orchestration.batch !== 'boolean'
      || !['required', 'skip'].includes(orchestration.preflight.doctor)
      || !['required', 'skip'].includes(orchestration.preflight.connectivity)
      || !['enabled-outside-core', 'disabled'].includes(orchestration.diagnostic)
      || !['append', 'skip'].includes(orchestration.managedEvidence)
      || (orchestration.gold !== undefined
        && orchestration.gold.comparisonMode !== 'exploratory-post-hoc')) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: 'orchestration',
    message: 'EvaluationOrchestrationOptions 包含不合法的规范值。',
  });
  if (!presentation.outputDirectoryLocator
      || !['project', 'global'].includes(presentation.indexScope)
      || !['zh', 'en'].includes(presentation.language)
      || typeof presentation.serve !== 'boolean'
      || typeof presentation.verbose !== 'boolean'
      || typeof presentation.layeredView !== 'boolean'
      || !['gate', 'report-only'].includes(presentation.exitMode)) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: 'presentation',
    message: 'EvaluationPresentationOptions 包含不合法的规范值。',
  });
  const cache = input.policy.cache;
  if (cache === null || typeof cache !== 'object' || Array.isArray(cache)) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: 'policy.cache',
    message: 'cache policy 必须分别声明 executionMode 与 evaluationMode。',
  });
  if (!['disabled', 'replay-only', 'transparent-deterministic']
    .includes(cache.executionMode)) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: 'policy.cache.executionMode',
    message: 'execution cache mode 不合法。',
  });
  if (!['disabled', 'reuse'].includes(cache.evaluationMode)) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: 'policy.cache.evaluationMode',
    message: 'evaluation cache mode 不合法。',
  });
  const cacheEnabled = cache.executionMode !== 'disabled'
    || cache.evaluationMode !== 'disabled';
  if (cacheEnabled
      && (orchestration.independentSeries?.repeatCount ?? 1) > 1) fail({
    code: 'CLI_INPUT_CACHE_SERIES_CONFLICT',
    fieldPath: 'orchestration.independentSeries.repeatCount',
    message: 'cache／replay fact 不得作为多个独立 Series member 重复计数。',
  });
  if (cacheEnabled && orchestration.resumeSourceLocator !== undefined) fail({
    code: 'CLI_INPUT_RESUME_CACHE_CONFLICT',
    fieldPath: 'orchestration.resumeSourceLocator',
    message: 'resume 与 cache／replay 是不同事实复用流程，不得在同一请求中混用。',
  });
  const executionSource = orchestration.cacheSources?.executionSourceLocator;
  const evaluationSource = orchestration.cacheSources?.evaluationSourceLocator;
  const validateCacheSource = (
    mode: string,
    locator: string | undefined,
    fieldPath: string,
  ): void => {
    if (mode !== 'disabled'
        && (typeof locator !== 'string' || locator.trim() === '')) fail({
      code: 'CLI_INPUT_CACHE_SOURCE_REQUIRED',
      fieldPath,
      message: `启用 cache／replay mode「${mode}」时必须声明显式 cache source。`,
    });
    if (mode === 'disabled' && locator !== undefined) fail({
      code: 'CLI_INPUT_CACHE_SOURCE_UNUSED',
      fieldPath,
      message: 'cache mode 为 disabled 时不得声明 cache source。',
    });
  };
  validateCacheSource(
    cache.executionMode,
    executionSource,
    'orchestration.cacheSources.executionSourceLocator',
  );
  validateCacheSource(
    cache.evaluationMode,
    evaluationSource,
    'orchestration.cacheSources.evaluationSourceLocator',
  );
}

function validateResourceReferences(
  input: ResolvedCliEvaluationInput,
  hostResources: ResolvedHostResources,
): void {
  const resourcesById = new Map(hostResources.resources.map((resource) => [
    resource.descriptor.resourceId,
    resource,
  ]));
  const validateReference = (
    descriptor: ResolvedResourceDescriptor,
    expectedResourceKinds: readonly ResolvedHostResource['resourceKind'][],
    fieldPath: string,
  ): void => {
    const resolved = resourcesById.get(descriptor.resourceId);
    if (resolved === undefined) fail({
      code: 'CLI_INPUT_RESOURCE_MISSING',
      fieldPath,
      message: `资源「${descriptor.resourceId}」没有宿主绑定。`,
    });
    if (!expectedResourceKinds.includes(resolved.resourceKind)) fail({
      code: 'CLI_INPUT_RESOURCE_KIND_MISMATCH',
      sourcePath: resolved.locator,
      fieldPath,
      details: {
        resourceId: descriptor.resourceId,
        actualResourceKind: resolved.resourceKind,
        expectedResourceKinds: [...expectedResourceKinds],
      },
      message: `资源「${descriptor.resourceId}」的宿主类型与引用角色不一致。`,
    });
    if (!descriptorMatches(descriptor, resolved.descriptor)) fail({
      code: 'CLI_INPUT_RESOURCE_DIGEST_MISMATCH',
      sourcePath: resolved.locator,
      fieldPath,
      message: `资源「${descriptor.resourceId}」的行为描述与宿主绑定不一致。`,
    });
  };
  if (input.orchestration.gold !== undefined) {
    const gold = resourcesById.get(input.orchestration.gold.resourceId);
    if (gold === undefined || gold.descriptor.classification !== 'gold') fail({
      code: 'CLI_INPUT_RESOURCE_MISSING',
      fieldPath: 'orchestration.gold.resourceId',
      message: 'Gold 资源必须存在于宿主资源清单中，并标记为 gold。',
    });
    if (gold.resourceKind !== 'gold-dataset') fail({
      code: 'CLI_INPUT_RESOURCE_KIND_MISMATCH',
      sourcePath: gold.locator,
      fieldPath: 'orchestration.gold.resourceId',
      details: {
        resourceId: input.orchestration.gold.resourceId,
        actualResourceKind: gold.resourceKind,
        expectedResourceKinds: ['gold-dataset'],
      },
      message: 'Gold 资源的宿主类型必须是 gold-dataset。',
    });
  }
  for (const target of input.targets) {
    const prefix = `targets.${target.targetId}.behavior`;
    validateReference(target.behavior.artifact, ['artifact'], `${prefix}.artifact`);
    if (target.behavior.workspace !== undefined) {
      validateReference(target.behavior.workspace, ['workspace'], `${prefix}.workspace`);
    }
    if (target.behavior.mcpConfig !== undefined) {
      validateReference(target.behavior.mcpConfig, ['mcp-config'], `${prefix}.mcpConfig`);
    }
    for (const [mockIndex, mock] of (target.behavior.mocks ?? []).entries()) {
      for (const [payloadIndex, payload] of mock.payloads.entries()) {
        validateReference(
          payload,
          ['mock-payload'],
          `${prefix}.mocks.${mockIndex}.payloads.${payloadIndex}`,
        );
      }
    }
  }
  for (const template of input.evaluatorTemplates) {
    for (const [resourceIndex, resource] of (template.resources ?? []).entries()) {
      validateReference(
        resource,
        ['content'],
        `evaluatorTemplates.${template.evaluatorId}.resources.${resourceIndex}`,
      );
    }
  }
}

function behaviorConfig(
  behavior: ResolvedTargetBehavior,
  runtime: ResolvedCliEvaluationInput['targets'][number]['executor'],
): JsonValue {
  if (behavior.config !== undefined
      && behavior.config.classification !== 'public'
      && behavior.config.classification !== 'sensitive') fail({
    code: 'CLI_INPUT_RESTRICTED_INLINE_CONTENT',
    fieldPath: 'targets[].behavior.config.classification',
    message: 'Target config 不得内联 secret 或 gold 内容，请改用 digest-bound resource descriptor。',
  });
  if (behavior.sandbox?.config !== undefined
      && behavior.sandbox.config.classification !== 'public'
      && behavior.sandbox.config.classification !== 'sensitive') fail({
    code: 'CLI_INPUT_RESTRICTED_INLINE_CONTENT',
    fieldPath: 'targets[].behavior.sandbox.config.classification',
    message: 'Sandbox config 不得内联 secret 或 gold 内容，请改用 digest-bound resource descriptor。',
  });
  return canonicalSnapshot({
    behavior: {
      artifact: descriptorSnapshot(behavior.artifact),
      ...(behavior.workspace === undefined ? {} : { workspace: descriptorSnapshot(behavior.workspace) }),
      ...(behavior.mcpConfig === undefined ? {} : { mcpConfig: descriptorSnapshot(behavior.mcpConfig) }),
      ...(behavior.mocks === undefined ? {} : {
        mocks: behavior.mocks.map((mock) => ({
          matchRules: canonicalSnapshot(mock.matchRules),
          strict: mock.strict,
          payloads: [...mock.payloads]
            .sort((left, right) => compareStrings(left.resourceId, right.resourceId))
            .map(descriptorSnapshot),
        })),
      }),
      ...(behavior.allowedTools === undefined ? {} : {
        allowedTools: [...behavior.allowedTools].sort(compareStrings),
      }),
      ...(behavior.allowedSkills === undefined ? {} : {
        allowedSkills: [...behavior.allowedSkills].sort(compareStrings),
      }),
      ...(behavior.sandbox === undefined ? {} : {
        sandbox: {
          sandboxId: behavior.sandbox.sandboxId,
          ...(behavior.sandbox.config === undefined ? {} : {
            config: {
              classification: behavior.sandbox.config.classification,
              value: canonicalSnapshot(behavior.sandbox.config.value),
            },
          }),
        },
      }),
      ...(behavior.config === undefined ? {} : {
        config: {
          classification: behavior.config.classification,
          value: canonicalSnapshot(behavior.config.value),
        },
      }),
    },
    runtime: {
      model: runtime.model,
      ...(runtime.effort === undefined ? {} : { effort: runtime.effort }),
    },
  });
}

function evaluatorConfig(
  template: ResolvedEvaluatorTemplate,
  member?: ResolvedJudgeMember,
): JsonValue | undefined {
  if (template.config !== undefined
      && template.config.classification !== 'public'
      && template.config.classification !== 'sensitive') fail({
    code: 'CLI_INPUT_RESTRICTED_INLINE_CONTENT',
    fieldPath: `evaluatorTemplates.${template.evaluatorId}.config.classification`,
    message: 'Evaluator config 不得内联 secret 或 gold 内容，请改用 digest-bound resource descriptor。',
  });
  if (template.config === undefined && template.resources === undefined && member === undefined) return undefined;
  return canonicalSnapshot({
    ...(template.config === undefined ? {} : {
      evaluator: {
        classification: template.config.classification,
        value: canonicalSnapshot(template.config.value),
      },
    }),
    ...(template.resources === undefined ? {} : {
      resources: [...template.resources]
        .sort((left, right) => compareStrings(left.resourceId, right.resourceId))
        .map(descriptorSnapshot),
    }),
    ...(member === undefined ? {} : {
      runtime: {
        executorId: member.executorId,
        model: member.model,
        promptVariant: member.promptVariant,
        ...(member.effort === undefined ? {} : { effort: member.effort }),
      },
    }),
  });
}

function makeEvaluator(
  template: ResolvedEvaluatorTemplate,
  input: {
    evaluatorId: string;
    implementationId: string;
    versionConstraint?: string;
    ensembleMemberId: string;
    replicateIndex: number;
    member?: ResolvedJudgeMember;
  },
): EvaluatorDefinition {
  const config = evaluatorConfig(template, input.member);
  return {
    evaluatorId: input.evaluatorId,
    evaluatorKind: template.evaluatorKind,
    implementationId: input.implementationId,
    ...(input.versionConstraint === undefined ? {} : { versionConstraint: input.versionConstraint }),
    measurement: {
      instrumentId: template.instrumentId,
      ensembleMemberId: input.ensembleMemberId,
      replicateGroupId: template.replicateGroupId,
      replicateIndex: input.replicateIndex,
    },
    metricIds: [...template.metricIds].sort(compareStrings),
    inputs: [...template.inputs].sort((left, right) => compareStrings(left.bindingId, right.bindingId)),
    ...(config === undefined ? {} : { config }),
  };
}

function compileEvaluators(input: ResolvedCliEvaluationInput): EvaluatorDefinition[] {
  assertUnique(input.evaluatorTemplates.map((template) => template.evaluatorId), 'evaluatorTemplates[].evaluatorId');
  assertUnique(input.evaluatorTemplates.map((template) => (
    `${template.instrumentId}\u0000${template.replicateGroupId}`
  )), 'evaluatorTemplates[].measurementIdentity');
  assertUnique(input.judges.members.map((member) => member.ensembleMemberId), 'judges.members[].ensembleMemberId');
  if (!Number.isInteger(input.judges.replicateCount) || input.judges.replicateCount < 1) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: 'judges.replicateCount',
    message: '评委 replicate 数量必须是正整数。',
  });
  const hasJudgeTemplate = input.evaluatorTemplates.some((template) => template.runtimeBindingKind === 'judge');
  if (input.judges.enabled && hasJudgeTemplate && input.judges.members.length === 0) fail({
    code: 'CLI_INPUT_JUDGE_REQUIRED',
    fieldPath: 'judges.members',
    message: '启用评委时必须提供至少一个经过解析的评委实现。',
  });

  const evaluators: EvaluatorDefinition[] = [];
  for (const template of input.evaluatorTemplates) {
    if (template.runtimeBindingKind === 'builtin') {
      if (template.implementationId === undefined) fail({
        code: 'CLI_INPUT_INVALID',
        fieldPath: `evaluatorTemplates.${template.evaluatorId}.implementationId`,
        message: `内置 evaluator「${template.evaluatorId}」缺少 implementationId。`,
      });
      evaluators.push(makeEvaluator(template, {
        evaluatorId: template.evaluatorId,
        implementationId: template.implementationId,
        versionConstraint: template.versionConstraint,
        ensembleMemberId: `${template.evaluatorId}-builtin`,
        replicateIndex: 0,
      }));
      continue;
    }
    if (!input.judges.enabled) continue;
    for (const member of [...input.judges.members]
      .sort((left, right) => compareStrings(left.ensembleMemberId, right.ensembleMemberId))) {
      for (let replicateIndex = 0; replicateIndex < input.judges.replicateCount; replicateIndex += 1) {
        evaluators.push(makeEvaluator(template, {
          evaluatorId: `${template.evaluatorId}--${member.ensembleMemberId}--r${replicateIndex}`,
          implementationId: member.implementationId,
          versionConstraint: member.versionConstraint,
          ensembleMemberId: member.ensembleMemberId,
          replicateIndex,
          member,
        }));
      }
    }
  }
  assertUnique(evaluators.map((evaluator) => evaluator.evaluatorId), 'definition.evaluators[].evaluatorId');
  return evaluators.sort((left, right) => compareStrings(left.evaluatorId, right.evaluatorId));
}

function compileDefinition(input: ResolvedCliEvaluationInput): EvaluationDefinition {
  assertUnique(input.dataset.samples.map((sample) => sample.sampleId), 'dataset.samples[].sampleId');
  assertUnique(input.targets.map((target) => target.targetId), 'targets[].targetId');
  assertUnique(input.metrics.map((metric) => metric.metricId), 'metrics[].metricId');
  const controls = input.targets.filter((target) => target.experimentRole === 'control');
  const treatments = input.targets.filter((target) => target.experimentRole === 'treatment');
  if (controls.length !== 1) fail({
    code: 'CLI_INPUT_CONTROL_REQUIRED',
    fieldPath: 'targets[].experimentRole',
    message: 'Evaluation Core 编译要求且仅允许一个 control target。',
  });
  if (treatments.length === 0) fail({
    code: 'CLI_INPUT_TREATMENT_REQUIRED',
    fieldPath: 'targets[].experimentRole',
    message: 'Evaluation Core 编译要求至少一个 treatment target。',
  });
  if (input.metrics.length === 0) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: 'metrics',
    message: '至少需要一个 metric 才能建立比较契约。',
  });
  const targets = [...input.targets]
    .sort((left, right) => compareStrings(left.targetId, right.targetId))
    .map((target) => ({
      targetId: target.targetId,
      targetKind: target.targetKind,
      protocolId: target.protocolId,
      executorId: target.executor.implementationId,
      ...(target.executor.versionConstraint === undefined
        ? {}
        : { versionConstraint: target.executor.versionConstraint }),
      config: behaviorConfig(target.behavior, target.executor),
    }));
  const analysisNodes = [...input.analysisGraph.nodes]
    .map((node) => ({
      ...node,
      inputs: [...node.inputs].sort((left, right) => (
        compareStrings(left.inputKind, right.inputKind)
        || compareStrings(left.referenceId, right.referenceId)
      )),
    }))
    .sort((left, right) => compareStrings(left.nodeId, right.nodeId));
  const decisionPolicy = input.decisionPolicy === undefined ? undefined : {
    ...input.decisionPolicy,
    analysisResultIds: [...input.decisionPolicy.analysisResultIds].sort(compareStrings),
    ...(input.decisionPolicy.comparisonFamily === undefined ? {} : {
      comparisonFamily: [...input.decisionPolicy.comparisonFamily].sort((left, right) => (
        compareStrings(left.comparisonId, right.comparisonId)
        || compareStrings(left.treatmentTargetId, right.treatmentTargetId)
        || compareStrings(left.metricId, right.metricId)
      )),
    }),
  };
  const raw = canonicalSnapshot({
    schemaVersion: EVALUATION_DEFINITION_SCHEMA_VERSION,
    dataset: {
      datasetId: input.dataset.datasetId,
      samples: [...input.dataset.samples]
        .sort((left, right) => compareStrings(left.sampleId, right.sampleId)),
      ...(input.dataset.analysisCohorts === undefined ? {} : {
        analysisCohorts: [...input.dataset.analysisCohorts].sort((left, right) => (
          compareStrings(left.cohortSetId, right.cohortSetId)
          || compareStrings(left.cohortId, right.cohortId)
        )),
      }),
    },
    targets,
    evaluators: compileEvaluators(input),
    metrics: [...input.metrics].sort((left, right) => compareStrings(left.metricId, right.metricId)),
    experiment: {
      ...input.experiment,
      randomizationSlots: targets.map((target) => ({
        targetId: target.targetId,
        randomizationSlotId: `slot-${target.targetId}`,
      })),
    },
    analysisGraph: { analysisMode: input.analysisGraph.analysisMode, nodes: analysisNodes },
    comparisons: [{
      comparisonId: 'control-vs-treatments',
      controlTargetId: controls[0].targetId,
      treatmentTargetIds: treatments.map((target) => target.targetId).sort(compareStrings),
      metricIds: input.metrics.map((metric) => metric.metricId).sort(compareStrings),
    }],
    ...(decisionPolicy === undefined ? {} : { decisionPolicy }),
  });
  try {
    return deepFreezeCanonicalJson(normalizeEvaluationDefinition(raw));
  } catch (cause) {
    fail({
      code: 'CLI_INPUT_CORE_SCHEMA_INVALID',
      fieldPath: 'definition',
      message: '编译后的 EvaluationDefinition 不符合 Core schema。',
      cause,
    });
  }
}

function validateCompiledCoreSemantics(
  definition: EvaluationDefinition,
  policy: MeasurementPolicy,
): void {
  try {
    validateDefinitionSemantics(definition, policy);
  } catch (cause) {
    const coreError = cause instanceof EvaluationDefinitionError ? cause : undefined;
    fail({
      code: 'CLI_INPUT_CORE_SEMANTICS_INVALID',
      fieldPath: 'definition',
      message: '编译后的 EvaluationDefinition／MeasurementPolicy 未通过 Core 引用或静态语义校验。',
      ...(coreError === undefined ? {} : {
        details: canonicalSnapshot({
          coreCode: coreError.code,
          ...(coreError.details === undefined ? {} : { coreDetails: coreError.details }),
        }),
      }),
      cause,
    });
  }
}

function compilePolicy(input: ResolvedCliEvaluationInput): MeasurementPolicy {
  const policyInput = input.policy;
  if (!Number.isInteger(policyInput.retryCount) || policyInput.retryCount < 0) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: 'policy.retryCount',
    message: 'retryCount 必须是非负整数。',
  });
  const retry = {
    maxAttempts: policyInput.retryCount + 1,
    retryableErrorCodes: [...(policyInput.retryableErrorCodes ?? ['timeout', 'transport-error'])]
      .sort(compareStrings),
    backoff: { backoffKind: 'none' as const, initialDelayMs: 0 },
  };
  const budget = policyInput.budget;
  const cost = (amount: number | undefined): { amount: number; currency: string } | undefined => (
    amount === undefined ? undefined : { amount, currency: 'USD' }
  );
  const raw = canonicalSnapshot({
    schemaVersion: MEASUREMENT_POLICY_SCHEMA_VERSION,
    execution: {
      maxConcurrency: policyInput.executionConcurrency,
      ...(policyInput.executionTimeoutMs === undefined ? {} : { timeoutMs: policyInput.executionTimeoutMs }),
    },
    retry,
    budget: {
      run: {
        ...(budget?.runMaxInvocations === undefined ? {} : { maxInvocations: budget.runMaxInvocations }),
        ...(budget?.totalProviderCostUSD === undefined ? {} : {
          maxProviderCost: cost(budget.totalProviderCostUSD),
        }),
      },
      stages: {
        execution: budget?.executionMaxInvocations === undefined
          ? {}
          : { maxInvocations: budget.executionMaxInvocations },
        evaluation: budget?.evaluationMaxInvocations === undefined
          ? {}
          : { maxInvocations: budget.evaluationMaxInvocations },
      },
      coordinate: {
        ...(budget?.perCoordinateProviderCostUSD === undefined ? {} : {
          maxProviderCost: cost(budget.perCoordinateProviderCostUSD),
        }),
        ...(budget?.perCoordinateActiveDurationMs === undefined ? {} : {
          maxActiveDurationMs: budget.perCoordinateActiveDurationMs,
        }),
      },
      attempt: {},
      providerCostAdmission: {
        admissionMode: 'bounded-overshoot',
        unknownCostMode: 'fail-run',
      },
    },
    evaluation: {
      maxConcurrency: policyInput.evaluationConcurrency ?? policyInput.executionConcurrency,
      ...(policyInput.evaluationTimeoutMs === undefined ? {} : { timeoutMs: policyInput.evaluationTimeoutMs }),
      retry,
    },
    cache: policyInput.cache,
    evidence: policyInput.evidence ?? {
      output: 'full',
      trace: 'reference',
      evidence: 'full',
      maximumClassification: 'gold',
    },
    failure: policyInput.failure ?? { failureMode: 'continue' },
    eventDelivery: policyInput.eventDelivery ?? {
      writerMode: 'disabled',
      backpressureMode: 'block',
      writerFailureMode: 'ignore',
    },
  });
  try {
    return deepFreezeCanonicalJson(parseWireDocument(MeasurementPolicySchema, raw));
  } catch (cause) {
    fail({
      code: 'CLI_INPUT_CORE_SCHEMA_INVALID',
      fieldPath: 'policy',
      message: '编译后的 MeasurementPolicy 不符合 Core schema。',
      cause,
    });
  }
}

function resourceLeaseRequirementsForBehavior(
  behavior: ResolvedTargetBehavior,
): Extract<RuntimeBinding, { runtimeKind: 'executor' }>['resourceLeaseRequirements'] {
  const requirements = [
    {
      resourceId: behavior.artifact.resourceId,
      resourceRole: 'artifact' as const,
      leaseMode: 'immutable-snapshot' as const,
    },
    ...(behavior.workspace === undefined ? [] : [{
      resourceId: behavior.workspace.resourceId,
      resourceRole: 'workspace' as const,
      leaseMode: 'copy-on-write-overlay' as const,
    }]),
    ...(behavior.mcpConfig === undefined ? [] : [{
      resourceId: behavior.mcpConfig.resourceId,
      resourceRole: 'mcp-config' as const,
      leaseMode: 'immutable-snapshot' as const,
    }]),
    ...(behavior.mocks ?? []).flatMap((mock) => mock.payloads.map((payload) => ({
      resourceId: payload.resourceId,
      resourceRole: 'mock-payload' as const,
      leaseMode: 'immutable-snapshot' as const,
    }))),
  ];
  return [...new Map(requirements.map((requirement) => [
    `${requirement.resourceRole}\u0000${requirement.resourceId}`,
    requirement,
  ])).values()].sort((left, right) => (
    compareStrings(left.resourceRole, right.resourceRole)
    || compareStrings(left.resourceId, right.resourceId)
  ));
}

function compileSeries(
  input: ResolvedCliEvaluationInput,
  designDigest: Sha256Digest,
): CompiledIndependentSeries | undefined {
  const series = input.orchestration.independentSeries;
  if (series === undefined || series.repeatCount === 1) return undefined;
  if (!Number.isInteger(series.repeatCount) || series.repeatCount < 1) fail({
    code: 'CLI_INPUT_SERIES_INVALID',
    fieldPath: 'orchestration.independentSeries.repeatCount',
    message: '独立 Run repeat 数量必须是正整数。',
  });
  if (!series.seriesInstanceId || series.seriesInstanceId.length > 192) fail({
    code: 'CLI_INPUT_SERIES_INVALID',
    fieldPath: 'orchestration.independentSeries.seriesInstanceId',
    message: '独立 Series 必须由 orchestrator 提供不超过 192 字符的实例标识。',
  });
  const seriesDesignIdentity = digestCanonicalJson({
    measurementDesignDigest: designDigest,
    repeatCount: series.repeatCount,
    comparisonScope: series.comparisonScope ?? 'analysis',
    minimumStatus: series.minimumStatus ?? 'compatible',
  });
  const seriesId = `${series.seriesInstanceId}-${seriesDesignIdentity.slice(
    'sha256:'.length,
    'sha256:'.length + 16,
  )}`;
  const members = Array.from({ length: series.repeatCount }, (_, replicateIndex) => ({
    memberId: `${seriesId}-member-${replicateIndex}`,
    replicateIndex,
  }));
  try {
    const definition = createEvaluationSeriesDefinition({
      schemaVersion: EVALUATION_SERIES_DEFINITION_SCHEMA_VERSION,
      seriesId,
      analysisMode: 'preregistered',
      experimentalUnit: 'run',
      members,
      comparabilityPolicy: {
        designMode: 'exact-measurement-design',
        comparisonScope: series.comparisonScope ?? 'analysis',
        minimumStatus: series.minimumStatus ?? 'compatible',
      },
      analysisGraph: {
        nodes: [{
          nodeId: 'run-variance',
          implementationId: 'omk.series.variance/v1',
          analysisStandardId: 'omk.series.variance/v1',
          minimumMemberEvidenceStatus: 'partial',
          inputs: [{ seriesInputKind: 'members', referenceId: seriesId }],
          outputResultId: 'run-variance',
          parameters: { estimator: 'sample-variance', minimumMembers: 2 },
        }],
      },
    });
    return deepFreezeCanonicalJson({
      definition,
      memberships: members.map((member) => ({
        seriesDesignDigest: definition.seriesDesignDigest,
        memberId: member.memberId,
        replicateIndex: member.replicateIndex,
      })),
    });
  } catch (cause) {
    fail({
      code: 'CLI_INPUT_SERIES_INVALID',
      fieldPath: 'orchestration.independentSeries',
      message: '独立 Run repeat 无法编译为 Evaluation Series contract。',
      cause,
    });
  }
}

function compileRuntimeBinding(
  input: ResolvedCliEvaluationInput,
  definition: EvaluationDefinition,
  series: CompiledIndependentSeries | undefined,
): RuntimeBindingRequest {
  const inputTargetById = new Map(input.targets.map((target) => [target.targetId, target]));
  const judgeMemberById = new Map(input.judges.members.map((member) => [
    member.ensembleMemberId,
    member,
  ]));
  const templateByInstrument = new Map(input.evaluatorTemplates.map((template) => [
    `${template.instrumentId}\u0000${template.replicateGroupId}`,
    template,
  ]));
  const bindings: RuntimeBinding[] = [];
  for (const target of definition.targets) {
    const resolved = inputTargetById.get(target.targetId);
    if (resolved === undefined) continue;
    bindings.push({
      runtimeKind: 'executor',
      bindingId: `executor-${target.targetId}`,
      targetId: target.targetId,
      implementationId: target.executorId,
      ...(target.versionConstraint === undefined ? {} : { versionConstraint: target.versionConstraint }),
      protocolId: target.protocolId,
      behaviorConfigDigest: digestCanonicalJson(target.config ?? null),
      resourceLeaseRequirements: resourceLeaseRequirementsForBehavior(resolved.behavior),
      qualification: {
        model: resolved.executor.model,
        ...(resolved.executor.effort === undefined ? {} : { effort: resolved.executor.effort }),
        workspace: resolved.behavior.workspace === undefined ? 'not-required' : 'required',
        mcp: resolved.behavior.mcpConfig === undefined ? 'not-required' : 'required',
        mockInterception: resolved.behavior.mocks === undefined ? 'not-required' : 'required',
        toolPolicy: resolved.behavior.allowedTools === undefined ? 'runtime-default' : 'allow-list',
        skillDiscovery: resolved.behavior.allowedSkills === undefined
          ? 'runtime-default'
          : resolved.behavior.allowedSkills.length === 0
            ? 'disabled'
            : 'allow-list',
        ...(resolved.behavior.sandbox === undefined
          ? {}
          : { sandboxId: resolved.behavior.sandbox.sandboxId }),
        resourceIntegrity: 'digest-before-use',
      },
    });
  }
  for (const evaluator of definition.evaluators) {
    const template = templateByInstrument.get(
      `${evaluator.measurement.instrumentId}\u0000${evaluator.measurement.replicateGroupId}`,
    );
    const judgeMember = judgeMemberById.get(evaluator.measurement.ensembleMemberId);
    bindings.push({
      runtimeKind: 'evaluator',
      bindingId: `evaluator-${evaluator.evaluatorId}`,
      evaluatorId: evaluator.evaluatorId,
      implementationId: evaluator.implementationId,
      ...(evaluator.versionConstraint === undefined ? {} : { versionConstraint: evaluator.versionConstraint }),
      measurement: evaluator.measurement,
      ...(evaluator.config === undefined ? {} : { configDigest: digestCanonicalJson(evaluator.config) }),
      resourceLeaseRequirements: [...new Map([...(template?.resources ?? [])]
        .map((descriptor) => [descriptor.resourceId, descriptor])).values()]
        .map((descriptor) => ({
          resourceId: descriptor.resourceId,
          resourceRole: 'content' as const,
          leaseMode: 'immutable-snapshot' as const,
        }))
        .sort((left, right) => compareStrings(left.resourceId, right.resourceId)),
      ...(judgeMember === undefined ? {} : {
        qualification: {
          executorId: judgeMember.executorId,
          model: judgeMember.model,
          ...(judgeMember.effort === undefined ? {} : { effort: judgeMember.effort }),
          promptVariant: judgeMember.promptVariant,
          resourceIntegrity: 'digest-before-use',
        },
      }),
    });
  }
  for (const node of definition.analysisGraph.nodes) {
    bindings.push({
      runtimeKind: 'analysis-node',
      bindingId: `analysis-${node.nodeId}`,
      referenceId: node.nodeId,
      requirementKind: 'analysis-node',
      analysisNodeKind: node.analysisNodeKind,
      implementationId: node.implementationId,
      ...(node.versionConstraint === undefined ? {} : { versionConstraint: node.versionConstraint }),
    });
  }
  bindings.push({
    runtimeKind: 'analysis-node',
    bindingId: `sampling-estimator-${definition.experiment.sampling.estimatorId}`,
    referenceId: definition.experiment.sampling.estimatorId,
    requirementKind: 'sampling-estimator',
    analysisNodeKind: 'estimator',
    implementationId: definition.experiment.sampling.estimatorId,
  });
  for (const policyId of [...new Set(definition.metrics.map((metric) => (
    metric.missingPolicyId
  )))].sort(compareStrings)) {
    bindings.push({
      runtimeKind: 'missing-policy',
      bindingId: `missing-policy-${policyId}`,
      policyId,
      implementationId: policyId,
    });
  }
  if (definition.decisionPolicy !== undefined) {
    bindings.push({
      runtimeKind: 'decision-policy',
      bindingId: `decision-${definition.decisionPolicy.decisionPolicyId}`,
      decisionPolicyId: definition.decisionPolicy.decisionPolicyId,
      implementationId: definition.decisionPolicy.implementationId,
      ...(definition.decisionPolicy.versionConstraint === undefined
        ? {}
        : { versionConstraint: definition.decisionPolicy.versionConstraint }),
    });
  }
  for (const node of series?.definition.analysisGraph.nodes ?? []) {
    bindings.push({
      runtimeKind: 'series-analysis-node',
      bindingId: `series-analysis-${node.nodeId}`,
      nodeId: node.nodeId,
      implementationId: node.implementationId,
    });
  }
  if (series?.definition.decisionPolicy !== undefined) {
    bindings.push({
      runtimeKind: 'series-decision-policy',
      bindingId: `series-decision-${series.definition.decisionPolicy.decisionPolicyId}`,
      decisionPolicyId: series.definition.decisionPolicy.decisionPolicyId,
      implementationId: series.definition.decisionPolicy.implementationId,
    });
  }
  return deepFreezeCanonicalJson(canonicalSnapshot({
    schemaVersion: RUNTIME_BINDING_REQUEST_SCHEMA_VERSION,
    bindings: bindings.sort((left, right) => compareStrings(left.bindingId, right.bindingId)),
  })) as unknown as RuntimeBindingRequest;
}

/**
 * Pure deterministic compiler. It performs no filesystem, environment, network,
 * clock, Runtime resolution, or preflight work.
 */
export function compileCliEvaluationInput(
  input: Readonly<ResolvedCliEvaluationInput>,
): CliEvaluationCompileResult {
  const resolvedInput = canonicalSnapshot(input) as unknown as ResolvedCliEvaluationInput;
  if (resolvedInput.schemaVersion !== RESOLVED_CLI_EVALUATION_INPUT_SCHEMA_VERSION) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: 'schemaVersion',
    message: 'Resolved CLI evaluation input 版本不受支持。',
  });
  validateHostOptions(resolvedInput);
  const hostResources = normalizeHostResources(resolvedInput.hostResources);
  validateResourceReferences(resolvedInput, hostResources);
  const definition = compileDefinition(resolvedInput);
  const policy = compilePolicy(resolvedInput);
  validateCompiledCoreSemantics(definition, policy);
  const definitionDigest = digestCanonicalJson(definition);
  const policyDigest = digestCanonicalJson(policy);
  const series = compileSeries(resolvedInput, digestCanonicalJson({ definition, policy }));
  const orchestration: EvaluationOrchestrationOptions = deepFreezeCanonicalJson(canonicalSnapshot({
    dryRun: resolvedInput.orchestration.dryRun,
    batch: resolvedInput.orchestration.batch,
    ...(resolvedInput.orchestration.resumeSourceLocator === undefined ? {} : {
      resumeSourceLocator: resolvedInput.orchestration.resumeSourceLocator,
    }),
    preflight: resolvedInput.orchestration.preflight,
    diagnostic: resolvedInput.orchestration.diagnostic,
    managedEvidence: resolvedInput.orchestration.managedEvidence,
    ...(resolvedInput.orchestration.cacheSources === undefined ? {} : {
      cacheSources: resolvedInput.orchestration.cacheSources,
    }),
    ...(resolvedInput.orchestration.gold === undefined ? {} : { gold: resolvedInput.orchestration.gold }),
    ...(series === undefined ? {} : { independentSeries: series }),
  })) as unknown as EvaluationOrchestrationOptions;
  const presentation = deepFreezeCanonicalJson(
    canonicalSnapshot(resolvedInput.presentation),
  ) as unknown as CliEvaluationCompileResult['presentation'];
  const runOptions = deepFreezeCanonicalJson(canonicalSnapshot({
    ...(resolvedInput.staticRunMetadata === undefined ? {} : { metadata: resolvedInput.staticRunMetadata }),
  })) as unknown as CliEvaluationCompileResult['runOptions'];
  const runtimeBinding = compileRuntimeBinding(resolvedInput, definition, series);
  return deepFreezeCanonicalJson({
    definition,
    policy,
    runtimeBinding,
    hostResources,
    orchestration,
    presentation,
    runOptions,
    canonicalDigests: { definition: definitionDigest, policy: policyDigest },
  });
}
