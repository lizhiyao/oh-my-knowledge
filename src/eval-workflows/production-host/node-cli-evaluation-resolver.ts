import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import {
  canonicalizeJson,
  deepFreezeCanonicalJson,
  type JsonValue,
  type TargetExecutionControls,
} from '../../evaluation-core/contracts/index.js';
import { loadSamples } from '../../inputs/load-samples.js';
import { resolveArtifacts } from '../../inputs/skill-loader.js';
import type { Artifact } from '../../artifacts/contracts.js';
import type { Mock } from '../../inputs/contracts/mock.js';
import type { Sample } from '../../inputs/contracts/sample.js';
import {
  RESOLVED_CLI_EVALUATION_INPUT_SCHEMA_VERSION,
  RESOLVED_HOST_RESOURCES_SCHEMA_VERSION,
  CliEvaluationInputError,
  type CliEvaluationRequest,
  type ResolvedCliEvaluationInput,
  type ResolvedHostResource,
  type ResolvedMockBinding,
  type ResolvedResourceDescriptor,
} from '../input-compilation/index.js';
import {
  digestNodeFileResource,
  digestNodeTreeResource,
} from '../runtime-adapter/resource-leases/node.js';
import { BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID } from '../runtime-adapter/analysis/index.js';
import { buildProductionMeasurementDesign } from './measurement-design.js';

export interface ResolveNodeCliEvaluationRequestOptions {
  /** Absolute semantic root for relative CLI／eval.yaml locators. */
  readonly projectRoot: string;
  /** Resolver-owned directory for normalized inline or ephemeral resources. */
  readonly materializationRoot: string;
  /** Required when repeatCount > 1; identity allocation remains host-owned. */
  readonly seriesInstanceId?: string;
  /** Host-owned in-process Runtime implementations that need no executable resource. */
  readonly hostExecutorImplementationIds?: readonly string[];
  /** Host Runtime implementations whose reasoning configuration is provider-owned. */
  readonly hostOwnedEffortImplementationIds?: readonly string[];
}

interface ResourceRegistry {
  readonly resourcesById: Map<string, ResolvedHostResource>;
  add(resource: ResolvedHostResource): ResolvedResourceDescriptor;
}

type ExecutionWorkspaceDescriptor = Extract<
  TargetExecutionControls['defaults']['workspace'],
  { workspaceMode: 'copy-on-write-overlay' }
>['descriptor'];

function fail(input: ConstructorParameters<typeof CliEvaluationInputError>[0]): never {
  throw new CliEvaluationInputError(input);
}

function absolute(root: string, locator: string): string {
  return isAbsolute(locator) ? resolve(locator) : resolve(root, locator);
}

function executionWorkspaceDescriptor(
  descriptor: ResolvedResourceDescriptor,
): ExecutionWorkspaceDescriptor {
  if (descriptor.classification === 'gold') fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    fieldPath: 'executionControls.workspace.descriptor.classification',
    message: 'Executor workspace 不得使用 Gold classification。',
  });
  return descriptor as ExecutionWorkspaceDescriptor;
}

function mediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.json': return 'application/json';
    case '.yaml':
    case '.yml': return 'application/yaml';
    case '.md': return 'text/markdown';
    default: return 'text/plain';
  }
}

function resourceId(
  resourceKind: ResolvedHostResource['resourceKind'],
  digest: ResolvedResourceDescriptor['digest'],
  identityScope?: string,
): string {
  const contentId = digest.slice('sha256:'.length);
  return identityScope === undefined
    ? `${resourceKind}-${contentId}`
    : `${resourceKind}-${createHash('sha256').update(identityScope).digest('hex').slice(0, 16)}-${contentId}`;
}

function registry(): ResourceRegistry {
  const resourcesById = new Map<string, ResolvedHostResource>();
  return {
    resourcesById,
    add(resource) {
      const existing = resourcesById.get(resource.descriptor.resourceId);
      if (existing !== undefined) {
        if (canonicalizeJson(existing.descriptor) !== canonicalizeJson(resource.descriptor)
            || existing.resourceKind !== resource.resourceKind) fail({
          code: 'CLI_INPUT_RESOLUTION_FAILED',
          fieldPath: `hostResources.${resource.descriptor.resourceId}`,
          message: '内容寻址资源发生 descriptor 冲突。',
        });
        return existing.descriptor;
      }
      resourcesById.set(resource.descriptor.resourceId, resource);
      return resource.descriptor;
    },
  };
}

const PRODUCTION_EXECUTOR_IMPLEMENTATION_IDS = new Set([
  'codex',
  'codex-sdk',
  'claude',
  'claude-sdk',
  'openai-api',
  'anthropic-api',
]);

interface ResolvedTargetRuntime {
  readonly implementationId: string;
  readonly implementationResource?: ResolvedResourceDescriptor;
}

async function resolveTargetRuntime(
  resources: ResourceRegistry,
  projectRoot: string,
  requestedExecutorId: string,
  hostExecutorImplementationIds: ReadonlySet<string>,
): Promise<ResolvedTargetRuntime> {
  if (PRODUCTION_EXECUTOR_IMPLEMENTATION_IDS.has(requestedExecutorId)
      || hostExecutorImplementationIds.has(requestedExecutorId)) {
    return { implementationId: requestedExecutorId };
  }
  const executablePath = absolute(projectRoot, requestedExecutorId);
  const descriptor = await fileResource(resources, {
    resourceKind: 'runtime-implementation',
    path: executablePath,
    classification: 'sensitive',
    mediaType: 'application/vnd.omk.custom-command-runtime',
    lineage: {
      lineageKind: 'custom-command-runtime',
      exchangeSchemaVersion: 'omk.custom-command-exchange/v1',
    },
  });
  return {
    implementationId: `custom-command-${descriptor.digest.slice('sha256:'.length)}`,
    implementationResource: descriptor,
  };
}

async function fileResource(
  resources: ResourceRegistry,
  input: {
    readonly resourceKind: ResolvedHostResource['resourceKind'];
    readonly path: string;
    readonly classification: ResolvedResourceDescriptor['classification'];
    readonly mediaType?: string;
    readonly lineage?: JsonValue;
    readonly identityScope?: string;
  },
): Promise<ResolvedResourceDescriptor> {
  let measured: Awaited<ReturnType<typeof digestNodeFileResource>>;
  try {
    measured = await digestNodeFileResource(input.path);
  } catch (cause) {
    return fail({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      sourcePath: input.path,
      message: '无法读取并验证文件资源。',
      cause,
    });
  }
  const descriptor: ResolvedResourceDescriptor = {
    resourceId: resourceId(input.resourceKind, measured.digest, input.identityScope),
    digest: measured.digest,
    mediaType: input.mediaType ?? mediaType(input.path),
    classification: input.classification,
    size: measured.size,
  };
  return resources.add({
    resourceKind: input.resourceKind,
    descriptor,
    locator: input.path,
    ...(input.lineage === undefined ? {} : { lineage: input.lineage }),
    verification: {
      verificationKind: 'content-digest',
      verifiedDigest: descriptor.digest,
    },
  });
}

async function treeResource(
  resources: ResourceRegistry,
  input: {
    readonly resourceKind: 'artifact' | 'workspace' | 'gold-dataset';
    readonly path: string;
    readonly classification: ResolvedResourceDescriptor['classification'];
    readonly mediaType: string;
    readonly lineage?: JsonValue;
    readonly identityScope?: string;
  },
): Promise<ResolvedResourceDescriptor> {
  let measured: Awaited<ReturnType<typeof digestNodeTreeResource>>;
  try {
    measured = await digestNodeTreeResource(input.path);
  } catch (cause) {
    return fail({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      sourcePath: input.path,
      message: '无法读取并验证目录树资源。',
      cause,
    });
  }
  const descriptor: ResolvedResourceDescriptor = {
    resourceId: resourceId(input.resourceKind, measured.digest, input.identityScope),
    digest: measured.digest,
    mediaType: input.mediaType,
    classification: input.classification,
    size: measured.size,
  };
  return resources.add({
    resourceKind: input.resourceKind,
    descriptor,
    locator: input.path,
    ...(input.lineage === undefined ? {} : { lineage: input.lineage }),
    verification: { verificationKind: 'tree-digest', verifiedDigest: descriptor.digest },
  });
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function materializeBytes(
  root: string,
  bytes: Uint8Array,
  extension: '.json' | '.txt' | '.md',
): Promise<string> {
  const digest = sha256(bytes);
  const directory = join(root, 'content');
  const path = join(directory, `${digest.slice('sha256:'.length)}${extension}`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      sourcePath: directory,
      message: 'Resolver materialization content path 必须是普通目录，不能是符号链接。',
    });
    await chmod(directory, 0o700);
    try {
      const existingStat = await lstat(path);
      if (!existingStat.isFile() || existingStat.isSymbolicLink()) fail({
        code: 'CLI_INPUT_RESOLUTION_FAILED',
        sourcePath: path,
        message: 'Resolver materialization path 必须是普通文件，不能是符号链接。',
      });
      const existing = await readFile(path);
      if (sha256(existing) !== digest) fail({
        code: 'CLI_INPUT_RESOLUTION_FAILED',
        sourcePath: path,
        message: 'Resolver materialization path 已存在但内容摘要不一致。',
      });
      await chmod(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        const existingStat = await lstat(path);
        if (!existingStat.isFile() || existingStat.isSymbolicLink()) fail({
          code: 'CLI_INPUT_RESOLUTION_FAILED',
          sourcePath: path,
          message: '并发物化命中的 path 必须是普通文件，不能是符号链接。',
        });
        const existing = await readFile(path);
        if (sha256(existing) !== digest) fail({
          code: 'CLI_INPUT_RESOLUTION_FAILED',
          sourcePath: path,
          message: '并发物化命中了摘要不一致的既有资源。',
        });
        await chmod(path, 0o600);
      }
    }
  } catch (cause) {
    if (cause instanceof CliEvaluationInputError) throw cause;
    return fail({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      sourcePath: path,
      message: '无法安全物化 resolver-owned 资源。',
      cause,
    });
  }
  return path;
}

async function artifactResource(
  resources: ResourceRegistry,
  artifact: Readonly<Artifact>,
  targetId: string,
  materializationRoot: string,
): Promise<ResolvedResourceDescriptor> {
  const lineage: JsonValue = {
    targetId,
    sourceKind: artifact.source,
    artifactKind: artifact.kind,
    ...(artifact.locator === undefined ? {} : { sourceLocator: artifact.locator }),
    ...(artifact.skillRoot === undefined ? {} : { skillRootLocator: artifact.skillRoot }),
    ...(artifact.cwd === undefined ? {} : { workingDirectoryLocator: artifact.cwd }),
    ...(artifact.ref === undefined ? {} : { ref: artifact.ref }),
    ...(artifact.resolvedCommit === undefined ? {} : { commitId: artifact.resolvedCommit }),
    ...(artifact.contentHash === undefined ? {} : { sourceContentHash: artifact.contentHash }),
  };
  const candidate = artifact.execRoot ?? artifact.skillRoot ?? artifact.locator;
  if (candidate !== undefined && isAbsolute(candidate)) {
    let stat: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      stat = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail({
        code: 'CLI_INPUT_RESOLUTION_FAILED',
        sourcePath: candidate,
        message: '无法检查 knowledge artifact locator。',
        cause: error,
      });
    }
    if (stat?.isDirectory()) return treeResource(resources, {
      resourceKind: 'artifact',
      path: candidate,
      classification: 'sensitive',
      mediaType: 'application/vnd.omk.knowledge-artifact-tree',
      lineage,
      identityScope: targetId,
    });
    if (stat?.isFile()) {
      let path: string;
      try {
        path = await materializeBytes(materializationRoot, await readFile(candidate), '.md');
      } catch (cause) {
        if (cause instanceof CliEvaluationInputError) throw cause;
        return fail({
          code: 'CLI_INPUT_RESOLUTION_FAILED',
          sourcePath: candidate,
          message: '无法封存 knowledge artifact 文件。',
          cause,
        });
      }
      return fileResource(resources, {
        resourceKind: 'artifact',
        path,
        classification: 'sensitive',
        mediaType: mediaType(candidate),
        lineage,
        identityScope: targetId,
      });
    }
    if (stat !== undefined) {
      fail({
        code: 'CLI_INPUT_RESOLUTION_FAILED',
        sourcePath: candidate,
        message: 'Knowledge artifact 必须是普通文件或不含特殊条目的目录树。',
      });
    }
  }
  const content = artifact.content ?? '';
  const path = await materializeBytes(materializationRoot, Buffer.from(content), '.md');
  return fileResource(resources, {
    resourceKind: 'artifact',
    path,
    classification: 'sensitive',
    mediaType: 'text/markdown',
    lineage,
    identityScope: targetId,
  });
}

async function mockPayloadDescriptors(
  resources: ResourceRegistry,
  mock: Readonly<Mock>,
  samplesBaseDir: string,
  materializationRoot: string,
): Promise<readonly ResolvedResourceDescriptor[]> {
  if (mock.return_file !== undefined) {
    const path = absolute(samplesBaseDir, mock.return_file);
    return [await fileResource(resources, {
      resourceKind: 'mock-payload',
      path,
      classification: 'secret',
    })];
  }
  const values = mock.return_seq ?? (mock.return === undefined ? [''] : [mock.return]);
  return Promise.all(values.map(async (value) => {
    const objectValue = typeof value === 'object' && value !== null;
    const bytes = Buffer.from(objectValue ? JSON.stringify(value) : String(value));
    const path = await materializeBytes(
      materializationRoot,
      bytes,
      objectValue ? '.json' : '.txt',
    );
    return fileResource(resources, {
      resourceKind: 'mock-payload',
      path,
      classification: 'secret',
      mediaType: objectValue ? 'application/json' : 'text/plain',
    });
  }));
}

async function resolvedMocks(
  resources: ResourceRegistry,
  samples: readonly Readonly<Sample>[],
  samplesBaseDir: string,
  materializationRoot: string,
): Promise<readonly ResolvedMockBinding[]> {
  const bindings: ResolvedMockBinding[] = [];
  for (const sample of samples) {
    for (const mock of sample.mocks ?? []) {
      bindings.push({
        sampleIds: [sample.sample_id],
        matchRules: {
          tool: mock.tool,
          ...(mock.match === undefined ? {} : { match: structuredClone(mock.match) as JsonValue }),
        },
        strict: sample.mocksStrict ?? false,
        payloads: await mockPayloadDescriptors(
          resources,
          mock,
          samplesBaseDir,
          materializationRoot,
        ),
      });
    }
  }
  return bindings;
}

async function resolvedExecutionControls(
  resources: ResourceRegistry,
  samples: readonly Readonly<Sample>[],
  projectRoot: string,
  targetWorkspaceLocator: string | undefined,
): Promise<TargetExecutionControls> {
  const defaultWorkspace = targetWorkspaceLocator === undefined
    ? undefined
    : await treeResource(resources, {
        resourceKind: 'workspace',
        path: absolute(projectRoot, targetWorkspaceLocator),
        classification: 'sensitive',
        mediaType: 'application/vnd.omk.workspace-tree',
      });
  const sampleOverrides = (await Promise.all(samples.map(async (sample) => {
    const workspace = targetWorkspaceLocator !== undefined || sample.cwd === undefined
      ? undefined
      : await treeResource(resources, {
          resourceKind: 'workspace',
          path: absolute(projectRoot, sample.cwd),
          classification: 'sensitive',
          mediaType: 'application/vnd.omk.workspace-tree',
        });
    const tools = sample.allowedTools === undefined
      ? undefined
      : {
          toolPolicyKind: 'allow-list' as const,
          allowedTools: [...sample.allowedTools].sort(),
        };
    if (workspace === undefined && tools === undefined) return undefined;
    return {
      sampleId: sample.sample_id,
      ...(workspace === undefined ? {} : {
        workspace: {
          workspaceMode: 'copy-on-write-overlay' as const,
            descriptor: executionWorkspaceDescriptor(workspace),
        },
      }),
      ...(tools === undefined ? {} : { tools }),
    };
  }))).filter((override) => override !== undefined);
  return {
    defaults: {
      workspace: defaultWorkspace === undefined
        ? { workspaceMode: 'not-required' }
        : {
            workspaceMode: 'copy-on-write-overlay',
            descriptor: executionWorkspaceDescriptor(defaultWorkspace),
          },
      tools: { toolPolicyKind: 'runtime-default' },
    },
    sampleOverrides,
  };
}

async function optionalFileResource(
  resources: ResourceRegistry,
  projectRoot: string,
  locator: string | undefined,
  resourceKind: 'mcp-config' | 'gold-dataset',
): Promise<ResolvedResourceDescriptor | undefined> {
  if (locator === undefined) return undefined;
  const path = absolute(projectRoot, locator);
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (cause) {
    return fail({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      sourcePath: path,
      message: '无法读取可选宿主资源。',
      cause,
    });
  }
  if (stat.isDirectory()) {
    if (resourceKind !== 'gold-dataset') fail({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      sourcePath: path,
      message: 'MCP config 必须是普通文件。',
    });
    return treeResource(resources, {
      resourceKind,
      path,
      classification: 'gold',
      mediaType: 'application/vnd.omk.gold-dataset-tree',
    });
  }
  if (!stat.isFile()) fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    sourcePath: path,
    message: '资源 locator 必须指向普通文件或受支持目录。',
  });
  return fileResource(resources, {
    resourceKind,
    path,
    classification: resourceKind === 'gold-dataset' ? 'gold' : 'sensitive',
  });
}

/** Production effect resolver. It never creates Runtime, runId, Plan, or persisted Run artifacts. */
export async function resolveNodeCliEvaluationRequest(
  request: Readonly<CliEvaluationRequest>,
  options: Readonly<ResolveNodeCliEvaluationRequestOptions>,
): Promise<ResolvedCliEvaluationInput> {
  if (!isAbsolute(options.projectRoot) || !isAbsolute(options.materializationRoot)) fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    fieldPath: 'resolver.options',
    message: 'projectRoot 与 materializationRoot 必须是绝对路径。',
  });
  const hostExecutorImplementationIds = new Set(
    options.hostExecutorImplementationIds ?? [],
  );
  const hostOwnedEffortImplementationIds = new Set(
    options.hostOwnedEffortImplementationIds ?? [],
  );
  if ([...hostExecutorImplementationIds].some((implementationId) => (
    typeof implementationId !== 'string'
      || implementationId.trim() === ''
      || implementationId !== implementationId.trim()
  ))) fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    fieldPath: 'resolver.options.hostExecutorImplementationIds',
    message: '宿主 Runtime implementationId 必须是非空规范字符串。',
  });
  if ([...hostOwnedEffortImplementationIds].some((implementationId) => (
    !hostExecutorImplementationIds.has(implementationId)
  ))) fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    fieldPath: 'resolver.options.hostOwnedEffortImplementationIds',
    message: '宿主管理 effort 的 Runtime 必须同时声明为宿主 Runtime。',
  });
  if (request.values.orchestration.batch) fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    fieldPath: 'orchestration.batch',
    message: 'Batch request 必须由 production host workflow 展开为独立 child evaluation。',
  });
  let loaded: ReturnType<typeof loadSamples>;
  let artifacts: Artifact[];
  try {
    loaded = loadSamples(
      absolute(options.projectRoot, request.values.locators.samples),
      { assertionValidationMode: 'strict' },
    );
    const skillDirectory = absolute(options.projectRoot, request.values.locators.skillDirectory);
    artifacts = resolveArtifacts(skillDirectory, request.values.variants.map((variant) => (
      variant.artifactSource.artifactSourceKind === 'remote-git'
        ? {
            git: {
              url: variant.artifactSource.url,
              ...(variant.artifactSource.ref === undefined
                ? {}
                : { ref: variant.artifactSource.ref }),
              spec: variant.artifactSource.spec,
            },
            ...(variant.workspaceLocator === undefined
              ? {}
              : { cwd: absolute(options.projectRoot, variant.workspaceLocator) }),
            name: variant.targetId,
          }
        : {
            expr: variant.artifactSource.expression.includes('/')
              && !variant.artifactSource.expression.startsWith('git:')
              ? absolute(options.projectRoot, variant.artifactSource.expression)
              : variant.artifactSource.expression,
            ...(variant.workspaceLocator === undefined
              ? {}
              : { cwd: absolute(options.projectRoot, variant.workspaceLocator) }),
          }
    )), {
      strictBaseline: request.values.measurement.baselineIsolation,
      materialize: true,
    });
  } catch (cause) {
    return fail({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      sourcePath: request.values.locators.samples,
      message: '无法解析 samples 或 knowledge artifact；详情已保留在受控 cause 中。',
      cause,
    });
  }
  if (artifacts.length !== request.values.variants.length) fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    fieldPath: 'variants',
    message: 'Artifact resolver 返回数量与 variant request 不一致。',
  });

  const resources = registry();
  const targetRuntime = await resolveTargetRuntime(
    resources,
    options.projectRoot,
    request.values.targetRuntime.executorId,
    hostExecutorImplementationIds,
  );
  const mocks = await resolvedMocks(
    resources,
    loaded.samples,
    loaded.baseDir,
    options.materializationRoot,
  );
  const mcpConfig = await optionalFileResource(
    resources,
    options.projectRoot,
    request.values.locators.mcpConfig,
    'mcp-config',
  );
  const gold = await optionalFileResource(
    resources,
    options.projectRoot,
    request.values.locators.gold,
    'gold-dataset',
  );

  const targets = await Promise.all(request.values.variants.map(async (variant, index) => {
    const artifact = artifacts[index]!;
    artifact.experimentRole = variant.experimentRole;
    if (variant.allowedSkills !== undefined) artifact.allowedSkills = [...variant.allowedSkills];
    const artifactDescriptor = await artifactResource(
      resources,
      artifact,
      variant.targetId,
      options.materializationRoot,
    );
    const executionControls = await resolvedExecutionControls(
      resources,
      loaded.samples,
      options.projectRoot,
      variant.workspaceLocator,
    );
    return {
      targetId: variant.targetId,
      experimentRole: variant.experimentRole,
      targetKind: artifact.kind,
      protocolId: 'omk.invoke/v1' as const,
      executor: {
        implementationId: targetRuntime.implementationId,
        ...(targetRuntime.implementationResource === undefined ? {} : {
          implementationResource: targetRuntime.implementationResource,
        }),
        model: request.values.targetRuntime.model,
        ...(hostOwnedEffortImplementationIds.has(targetRuntime.implementationId)
          ? {}
          : { effort: request.values.targetRuntime.effort }),
      },
      behavior: {
        systemInstructions: artifact.content === null ? 'not-required' as const : 'required' as const,
        artifact: artifactDescriptor,
        ...(mcpConfig === undefined ? {} : { mcpConfig }),
        ...(mocks.length === 0 ? {} : { mocks }),
        ...(artifact.allowedSkills === undefined
          ? {}
          : { allowedSkills: [...artifact.allowedSkills] }),
      },
      executionControls,
    };
  }));

  const design = buildProductionMeasurementDesign(request, loaded.samples);
  const repeatCount = request.values.orchestration.repeatCount;
  if (repeatCount > 1 && (options.seriesInstanceId?.trim() ?? '') === '') fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    fieldPath: 'orchestration.independentSeries.seriesInstanceId',
    message: 'repeat > 1 时必须由宿主分配 seriesInstanceId。',
  });
  const output: ResolvedCliEvaluationInput = {
    schemaVersion: RESOLVED_CLI_EVALUATION_INPUT_SCHEMA_VERSION,
    ...design,
    targets,
    experiment: {
      trials: 1,
      seed: design.dataset.datasetId,
      sampling: {
        experimentalUnit: 'sample',
        pairingKey: '/sampleId',
        repeatedMeasures: true,
        resamplingUnit: 'paired-block',
        estimatorId: BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
        seedCoupling: 'uncontrolled',
      },
      scheduling: {
        schedulingKind: 'randomized-block',
        blockSize: targets.length,
      },
    },
    policy: {
      executionConcurrency: request.values.measurement.executionConcurrency,
      evaluationConcurrency: request.values.measurement.executionConcurrency,
      executionTimeoutMs: request.values.measurement.timeoutMs,
      evaluationTimeoutMs: request.values.measurement.timeoutMs,
      retryCount: request.values.measurement.retryCount,
      cache: request.values.measurement.cache,
      ...(request.values.measurement.budget === undefined ? {} : {
        budget: request.values.measurement.budget,
      }),
    },
    hostResources: {
      schemaVersion: RESOLVED_HOST_RESOURCES_SCHEMA_VERSION,
      resources: [...resources.resourcesById.values()].sort((left, right) => (
        left.descriptor.resourceId < right.descriptor.resourceId ? -1
          : left.descriptor.resourceId > right.descriptor.resourceId ? 1 : 0
      )),
    },
    orchestration: {
      dryRun: request.values.orchestration.dryRun,
      batch: false,
      ...(request.values.orchestration.resumeSourceLocator === undefined ? {} : {
        // Core resume locators are stable run identities, never legacy report paths.
        resumeSourceLocator: request.values.orchestration.resumeSourceLocator,
      }),
      preflight: request.values.orchestration.preflight,
      diagnostic: request.values.orchestration.diagnostic,
      managedEvidence: request.values.orchestration.managedEvidence,
      ...(loaded.requires === undefined ? {} : {
        dependencyRequirements: {
          baseDirectoryLocator: resolve(loaded.baseDir),
          ...Object.fromEntries(Object.entries(loaded.requires)
            .filter((entry): entry is [string, string[]] => entry[1] !== undefined)
            .map(([key, values]) => [key, [...new Set(values)].sort()])),
        },
      }),
      ...(gold === undefined ? {} : {
        gold: { resourceId: gold.resourceId, comparisonMode: 'exploratory-post-hoc' },
      }),
      ...(repeatCount <= 1 ? {} : {
        independentSeries: {
          repeatCount,
          seriesInstanceId: options.seriesInstanceId!,
          comparisonScope: 'decision',
          minimumStatus: 'conditional',
        },
      }),
    },
    presentation: {
      ...request.values.presentation,
      outputDirectoryLocator: absolute(
        options.projectRoot,
        request.values.presentation.outputDirectoryLocator,
      ),
    },
    staticRunMetadata: {
      annotations: {
        inputSources: structuredClone(request.fieldSources) as unknown as JsonValue,
        sampleSourceCount: loaded.sourceFiles.length,
      },
    },
  };
  return deepFreezeCanonicalJson(output as unknown as JsonValue) as unknown as ResolvedCliEvaluationInput;
}
