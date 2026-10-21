import { compareStrings } from '../../../eval-core/primitives/ordering.js';
import { deepFreezeCanonicalJson, digestCanonicalJson, resolveEffectiveExecutionControl, type JsonValue } from '../../../eval-core/contracts/index.js';
import { RESOLVED_HOST_RESOURCES_SCHEMA_VERSION, type ResolvedCliEvaluationInput, type ResolvedHostResource, type ResolvedHostResources, type ResolvedResourceDescriptor } from '../types.js';
import { fail, canonicalSnapshot, assertUnique } from './values.js';

export function descriptorSnapshot(descriptor: ResolvedResourceDescriptor): JsonValue {
  return canonicalSnapshot({
    resourceId: descriptor.resourceId,
    digest: descriptor.digest,
    mediaType: descriptor.mediaType,
    classification: descriptor.classification,
    size: descriptor.size,
  });
}

function descriptorMatches(
  left: ResolvedResourceDescriptor,
  right: ResolvedResourceDescriptor,
): boolean {
  return digestCanonicalJson(descriptorSnapshot(left))
    === digestCanonicalJson(descriptorSnapshot(right));
}

export function normalizeHostResources(
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
      if (!['artifact', 'workspace', 'mcp-config', 'mock-plan', 'mock-rule', 'mock-payload', 'gold-dataset', 'runtime-implementation', 'content']
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
          || !Number.isSafeInteger(resource.descriptor.size)
          || resource.descriptor.size < 0
          || (resource.verification.verificationKind === 'pinned-git'
            && !/^[0-9a-f]{40,64}$/.test(resource.verification.commitId))) {
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
          ...(resource.verification.verificationKind === 'pinned-git'
            ? { commitId: resource.verification.commitId }
            : {}),
        },
      };
    });
  return deepFreezeCanonicalJson(canonicalSnapshot({
    schemaVersion: RESOLVED_HOST_RESOURCES_SCHEMA_VERSION,
    resources,
  })) as unknown as ResolvedHostResources;
}

export function validateHostResourceMaterializationSemantics(
  hostResources: ResolvedHostResources,
): void {
  for (const resource of hostResources.resources) {
    const fileOnly = ['mcp-config', 'mock-plan', 'mock-rule', 'mock-payload', 'runtime-implementation', 'content']
      .includes(resource.resourceKind);
    const gitAllowed = resource.resourceKind === 'artifact'
      || resource.resourceKind === 'workspace';
    if ((fileOnly && resource.verification.verificationKind !== 'content-digest')
        || (resource.resourceKind === 'workspace'
          && resource.verification.verificationKind === 'content-digest')
        || (resource.verification.verificationKind === 'pinned-git' && !gitAllowed)
        || ((resource.resourceKind === 'gold-dataset')
          !== (resource.descriptor.classification === 'gold'))
        || (['mcp-config', 'mock-plan', 'mock-rule', 'mock-payload'].includes(resource.resourceKind)
          && resource.descriptor.classification !== 'secret')
        || (resource.resourceKind === 'mock-rule'
          && resource.descriptor.mediaType !== 'application/json')
        || (resource.resourceKind === 'mock-plan'
          && resource.descriptor.mediaType
            !== 'application/vnd.omk.mock-interception-plan+json')) fail({
      code: 'CLI_INPUT_INVALID',
      sourcePath: resource.locator,
      fieldPath: `hostResources.${resource.descriptor.resourceId}`,
      message: '宿主资源的 kind、classification 与 verification kind 不匹配。',
    });
  }
}

export function validateHostOptions(input: ResolvedCliEvaluationInput): void {
  const orchestration = input.orchestration;
  const presentation = input.presentation;
  if (typeof orchestration.dryRun !== 'boolean'
      || typeof orchestration.batch !== 'boolean'
      || !['required', 'skip'].includes(orchestration.preflight.doctor)
      || !['required', 'skip'].includes(orchestration.preflight.connectivity)
      || !['enabled-outside-core', 'disabled'].includes(orchestration.diagnostic)
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
  const dependencyRequirements = orchestration.dependencyRequirements;
  if (dependencyRequirements !== undefined
      && (typeof dependencyRequirements.baseDirectoryLocator !== 'string'
        || dependencyRequirements.baseDirectoryLocator.trim() === '')) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: 'orchestration.dependencyRequirements.baseDirectoryLocator',
    message: 'Dependency requirement 必须声明非空的宿主 base directory locator。',
  });
  for (const [requirementKind, values] of Object.entries(
    dependencyRequirements ?? {},
  ).filter(([key]) => key !== 'baseDirectoryLocator')) {
    if (!['tools', 'files', 'env', 'preflight'].includes(requirementKind)
        || !Array.isArray(values)
        || values.length === 0
        || values.some((value) => typeof value !== 'string' || value.trim() === '')
        || new Set(values).size !== values.length) fail({
      code: 'CLI_INPUT_INVALID',
      fieldPath: `orchestration.dependencyRequirements.${requirementKind}`,
      message: 'Dependency requirement 必须是非空、无重复的字符串数组。',
    });
  }
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

export function validateResourceReferences(
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
    const sampleIds = new Set(input.dataset.samples.map((sample) => sample.sampleId));
    if (target.behavior.allowedSkills !== undefined) {
      assertUnique(target.behavior.allowedSkills, `${prefix}.allowedSkills`);
    }
    validateReference(target.behavior.artifact, ['artifact'], `${prefix}.artifact`);
    const controlPrefix = `targets.${target.targetId}.executionControls`;
    assertUnique(
      target.executionControls.sampleOverrides.map((override) => override.sampleId),
      `${controlPrefix}.sampleOverrides[].sampleId`,
    );
    for (const override of target.executionControls.sampleOverrides) {
      if (!sampleIds.has(override.sampleId)) fail({
        code: 'CLI_INPUT_INVALID',
        fieldPath: `${controlPrefix}.sampleOverrides[].sampleId`,
        message: 'Sample execution control override 必须引用存在的 sampleId。',
      });
    }
    const workspaceControls = [
      target.executionControls.defaults.workspace,
      ...target.executionControls.sampleOverrides.flatMap((override) => (
        override.workspace === undefined ? [] : [override.workspace]
      )),
    ];
    for (const [controlIndex, workspace] of workspaceControls.entries()) {
      if (workspace.workspaceMode === 'copy-on-write-overlay') {
        validateReference(
          workspace.descriptor as ResolvedResourceDescriptor,
          ['workspace'],
          `${controlPrefix}.workspace.${controlIndex}.descriptor`,
        );
      }
    }
    const toolControls = [
      target.executionControls.defaults.tools,
      ...target.executionControls.sampleOverrides.flatMap((override) => (
        override.tools === undefined ? [] : [override.tools]
      )),
    ];
    for (const [controlIndex, tools] of toolControls.entries()) {
      if (tools.toolPolicyKind === 'allow-list') {
        assertUnique(tools.allowedTools, `${controlPrefix}.tools.${controlIndex}.allowedTools`);
      }
    }
    const mockControls = [
      target.executionControls.defaults.mockInterception,
      ...target.executionControls.sampleOverrides.flatMap((override) => (
        override.mockInterception === undefined ? [] : [override.mockInterception]
      )),
    ];
    for (const [controlIndex, mockInterception] of mockControls.entries()) {
      if (mockInterception.mockInterceptionMode === 'pre-tool-call') {
        validateReference(
          mockInterception.descriptor as ResolvedResourceDescriptor,
          ['mock-plan'],
          `${controlPrefix}.mockInterception.${controlIndex}.descriptor`,
        );
      }
    }
    if (target.behavior.mcpConfig !== undefined) {
      validateReference(target.behavior.mcpConfig, ['mcp-config'], `${prefix}.mcpConfig`);
    }
    for (const [mockIndex, mock] of (target.behavior.mocks ?? []).entries()) {
      if (mock.sampleIds.length === 0
          || new Set(mock.sampleIds).size !== mock.sampleIds.length
          || mock.sampleIds.some((sampleId) => !sampleIds.has(sampleId))) fail({
        code: 'CLI_INPUT_INVALID',
        fieldPath: `${prefix}.mocks.${mockIndex}.sampleIds`,
        message: 'Mock binding 必须引用至少一个存在且不重复的 sampleId。',
      });
      validateReference(
        mock.rule,
        ['mock-rule'],
        `${prefix}.mocks.${mockIndex}.rule`,
      );
      for (const [payloadIndex, payload] of mock.payloads.entries()) {
        validateReference(
          payload,
          ['mock-payload'],
          `${prefix}.mocks.${mockIndex}.payloads.${payloadIndex}`,
        );
      }
    }
    const behaviorMockSampleIds = new Set(
      (target.behavior.mocks ?? []).flatMap((mock) => mock.sampleIds),
    );
    const controlledMockSampleIds = new Set(
      [...sampleIds].filter((sampleId) => (
        resolveEffectiveExecutionControl(target.executionControls, sampleId)
          .mockInterception.mockInterceptionMode === 'pre-tool-call'
      )),
    );
    if (behaviorMockSampleIds.size !== controlledMockSampleIds.size
        || [...behaviorMockSampleIds].some((sampleId) => !controlledMockSampleIds.has(sampleId))) {
      fail({
        code: 'CLI_INPUT_INVALID',
        fieldPath: `${controlPrefix}.mockInterception`,
        message: 'Mock behavior 与按 sample 生效的 interception control 必须覆盖同一组 sample。',
      });
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
