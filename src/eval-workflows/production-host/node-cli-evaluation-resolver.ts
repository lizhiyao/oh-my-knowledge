import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import {
  canonicalizeJson,
  deepFreezeCanonicalJson,
  type JsonValue,
} from '../../evaluation-core/contracts/index.js';
import { loadSamples } from '../../inputs/load-samples.js';
import { resolveArtifacts } from '../../inputs/skill-loader.js';
import type { Artifact, Mock, Sample } from '../../types/index.js';
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
}

interface ResourceRegistry {
  readonly resourcesById: Map<string, ResolvedHostResource>;
  add(resource: ResolvedHostResource): ResolvedResourceDescriptor;
}

function fail(input: ConstructorParameters<typeof CliEvaluationInputError>[0]): never {
  throw new CliEvaluationInputError(input);
}

function absolute(root: string, locator: string): string {
  return isAbsolute(locator) ? resolve(locator) : resolve(root, locator);
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
  const contentId = digest.slice('sha256:'.length, 'sha256:'.length + 24);
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
    sourceKind: artifact.source,
    artifactKind: artifact.kind,
    ...(artifact.locator === undefined ? {} : { sourceLocator: artifact.locator }),
    ...(artifact.ref === undefined ? {} : { ref: artifact.ref }),
    ...(artifact.resolvedCommit === undefined ? {} : { commitId: artifact.resolvedCommit }),
    ...(artifact.contentHash === undefined ? {} : { legacyContentHash: artifact.contentHash }),
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
    if (stat?.isFile()) return fileResource(resources, {
      resourceKind: 'artifact',
      path: candidate,
      classification: 'sensitive',
      lineage,
      identityScope: targetId,
    });
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

function commonAllowedTools(samples: readonly Readonly<Sample>[]): readonly string[] | undefined {
  const policies = samples.map((sample) => sample.allowedTools === undefined
    ? undefined
    : [...sample.allowedTools].sort());
  const identities = new Set(policies.map((policy) => canonicalizeJson(policy ?? null)));
  if (identities.size > 1) fail({
    code: 'CLI_INPUT_SAMPLE_CONTROL_CONFLICT',
    fieldPath: 'samples[].allowedTools',
    message: '当前 Target contract 不接受不同 sample 使用不同 allowedTools；请统一测试构造。',
  });
  return policies[0];
}

function commonSampleWorkspace(samples: readonly Readonly<Sample>[]): string | undefined {
  const locators = [...new Set(samples.map((sample) => sample.cwd ?? ''))];
  if (locators.length > 1) fail({
    code: 'CLI_INPUT_SAMPLE_CONTROL_CONFLICT',
    fieldPath: 'samples[].cwd',
    message: '当前 Target contract 不接受不同 sample 使用不同 cwd；请按 workspace 拆分 evaluation。',
  });
  return locators[0] || undefined;
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
  const mocks = await resolvedMocks(
    resources,
    loaded.samples,
    loaded.baseDir,
    options.materializationRoot,
  );
  const allowedTools = commonAllowedTools(loaded.samples);
  const sampleWorkspace = request.values.variants.some((variant) => (
    variant.workspaceLocator === undefined
  )) ? commonSampleWorkspace(loaded.samples) : undefined;
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
    const workspaceLocator = variant.workspaceLocator ?? sampleWorkspace;
    const workspace = workspaceLocator === undefined
      ? undefined
      : await treeResource(resources, {
          resourceKind: 'workspace',
          path: absolute(options.projectRoot, workspaceLocator),
          classification: 'sensitive',
          mediaType: 'application/vnd.omk.workspace-tree',
        });
    return {
      targetId: variant.targetId,
      experimentRole: variant.experimentRole,
      targetKind: artifact.kind,
      protocolId: 'omk.invoke/v1' as const,
      executor: {
        implementationId: request.values.targetRuntime.executorId,
        model: request.values.targetRuntime.model,
        effort: request.values.targetRuntime.effort,
      },
      behavior: {
        systemInstructions: artifact.content === null ? 'not-required' as const : 'required' as const,
        artifact: artifactDescriptor,
        ...(workspace === undefined ? {} : { workspace }),
        ...(mcpConfig === undefined ? {} : { mcpConfig }),
        ...(mocks.length === 0 ? {} : { mocks }),
        ...(allowedTools === undefined ? {} : { allowedTools }),
        ...(artifact.allowedSkills === undefined
          ? {}
          : { allowedSkills: [...artifact.allowedSkills] }),
      },
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
        resumeSourceLocator: absolute(
          options.projectRoot,
          request.values.orchestration.resumeSourceLocator,
        ),
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
